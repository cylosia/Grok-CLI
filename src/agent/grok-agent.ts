import { EventEmitter } from "events";
import { GrokClient, GrokMessage, GrokTool, GrokToolCall } from "../grok/client.js";
import { getAllGrokTools } from "../grok/tools.js";
import { getMCPManager } from "../grok/tools.js";
import {
  TextEditorTool,
  MorphEditorTool,
  BashTool,
  TodoTool,
  ConfirmationTool,
  SearchTool,
} from "../tools/index.js";
import { ToolResult } from "../types/index.js";
import { createTokenCounter, TokenCounter } from "../utils/token-counter.js";
import { loadCustomInstructions } from "../utils/custom-instructions.js";
import { getSettingsManager } from "../utils/settings-manager.js";
import { AgentSupervisor, TaskResult } from "./supervisor.js";

export interface ChatEntry {
  type: "user" | "assistant" | "tool_result" | "tool_call";
  content: string;
  timestamp: Date;
  toolCalls?: GrokToolCall[];
  toolCall?: GrokToolCall;
  toolResult?: { success: boolean; output?: string; error?: string };
  isStreaming?: boolean;
}

export interface StreamingChunk {
  type: "content" | "tool_calls" | "tool_result" | "done" | "token_count";
  content?: string;
  toolCalls?: GrokToolCall[];
  toolCall?: GrokToolCall;
  toolResult?: ToolResult;
  tokenCount?: number;
}

export class GrokAgent extends EventEmitter {
  private grokClient: GrokClient;
  private textEditor: TextEditorTool;
  private morphEditor: MorphEditorTool | null;
  private bash: BashTool;
  private todoTool: TodoTool;
  private confirmationTool: ConfirmationTool;
  private search: SearchTool;
  private chatHistory: ChatEntry[] = [];
  private messages: GrokMessage[] = [];
  private tokenCounter: TokenCounter;
  private abortController: AbortController | null = null;
  private mcpInitialized = false;
  private maxToolRounds: number;
  private supervisor: AgentSupervisor | null;

  constructor(
    apiKey: string,
    baseURL?: string,
    model?: string,
    maxToolRounds?: number,
    enableSupervisor = true
  ) {
    super();
    const manager = getSettingsManager();
    const savedModel = manager.getCurrentModel();
    const modelToUse = model || savedModel || "grok-420";
    this.maxToolRounds = maxToolRounds || 20;

    this.grokClient = new GrokClient(apiKey, modelToUse, baseURL);
    this.textEditor = new TextEditorTool();
    this.morphEditor = process.env.MORPH_API_KEY ? new MorphEditorTool() : null;
    this.bash = new BashTool();
    this.todoTool = new TodoTool();
    this.confirmationTool = new ConfirmationTool();
    this.search = new SearchTool();
    this.tokenCounter = createTokenCounter(modelToUse);
    this.supervisor = enableSupervisor ? new AgentSupervisor(apiKey) : null;

    this.setupSystemPrompt();
    void this.initializeMCP();
  }

  private setupSystemPrompt(): void {
    const custom = loadCustomInstructions() || "";
    const systemPrompt = [
      "You are Grok CLI, a terminal coding assistant.",
      "Use tools when needed, and be concise.",
      custom,
    ]
      .filter(Boolean)
      .join("\n\n");

    this.messages = [{ role: "system", content: systemPrompt }];
  }

  private async initializeMCP(): Promise<void> {
    if (this.mcpInitialized) {
      return;
    }

    try {
      const manager = getMCPManager();
      await manager.ensureServersInitialized();
      this.mcpInitialized = true;
    } catch {
      this.mcpInitialized = false;
    }
  }

  async processUserMessage(message: string): Promise<ChatEntry[]> {
    const entries: ChatEntry[] = [];
    const userEntry: ChatEntry = {
      type: "user",
      content: message,
      timestamp: new Date(),
    };

    this.chatHistory.push(userEntry);
    entries.push(userEntry);
    this.messages.push({ role: "user", content: message });

    this.abortController = new AbortController();
    const tools = await getAllGrokTools();
    let toolRounds = 0;

    while (toolRounds < this.maxToolRounds) {
      const assistantMessage = await this.grokClient.chat(this.messages, {
        tools,
        signal: this.abortController.signal,
      });

      this.messages.push(assistantMessage);

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCallEntry: ChatEntry = {
          type: "tool_call",
          content: `Calling ${assistantMessage.tool_calls.length} tool(s)`,
          toolCalls: assistantMessage.tool_calls,
          timestamp: new Date(),
        };
        entries.push(toolCallEntry);
        this.chatHistory.push(toolCallEntry);

        for (const toolCall of assistantMessage.tool_calls) {
          const result = await this.executeTool(toolCall);
          const toolResultEntry: ChatEntry = {
            type: "tool_result",
            content: result.success ? result.output || "Success" : result.error || "Tool failed",
            toolCall,
            toolResult: result,
            timestamp: new Date(),
          };
          entries.push(toolResultEntry);
          this.chatHistory.push(toolResultEntry);

          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.success
              ? result.output || JSON.stringify(result.data || {})
              : result.error || "Tool failed",
          });
        }

        toolRounds += 1;
        continue;
      }

      const content = assistantMessage.content || "";
      const assistantEntry: ChatEntry = {
        type: "assistant",
        content,
        timestamp: new Date(),
      };

      entries.push(assistantEntry);
      this.chatHistory.push(assistantEntry);
      return entries;
    }

    const failEntry: ChatEntry = {
      type: "assistant",
      content: "Stopped after reaching maximum tool rounds.",
      timestamp: new Date(),
    };
    this.chatHistory.push(failEntry);
    entries.push(failEntry);
    return entries;
  }

  async *processUserMessageStream(message: string): AsyncGenerator<StreamingChunk> {
    const userEntry: ChatEntry = {
      type: "user",
      content: message,
      timestamp: new Date(),
    };
    this.chatHistory.push(userEntry);
    this.messages.push({ role: "user", content: message });

    const totalTokens = this.tokenCounter.countTokens(message);
    yield { type: "token_count", tokenCount: totalTokens };

    this.abortController = new AbortController();
    const tools: GrokTool[] = await getAllGrokTools();
    const assistantParts: string[] = [];

    for await (const chunk of this.grokClient.chatStream(this.messages, {
      tools,
      signal: this.abortController.signal,
    })) {
      if (chunk.content) {
        assistantParts.push(chunk.content);
        yield { type: "content", content: chunk.content };
      }

      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        yield { type: "tool_calls", toolCalls: chunk.toolCalls };
      }
    }

    const assistantContent = assistantParts.join("");
    this.messages.push({ role: "assistant", content: assistantContent });
    this.chatHistory.push({
      type: "assistant",
      content: assistantContent,
      timestamp: new Date(),
    });

    yield { type: "done" };
  }

  private async executeTool(toolCall: GrokToolCall): Promise<ToolResult> {
    try {
      const argsRaw = toolCall.function.arguments || "{}";
      const args = JSON.parse(argsRaw) as Record<string, unknown>;

      switch (toolCall.function.name) {
        case "view_file":
          return this.textEditor.view(String(args.path || ""), this.toViewRange(args.start_line, args.end_line));
        case "create_file":
          return this.textEditor.create(String(args.path || ""), String(args.content || ""));
        case "str_replace_editor":
          return this.textEditor.strReplace(
            String(args.path || ""),
            String(args.old_str || ""),
            String(args.new_str || ""),
            Boolean(args.replace_all)
          );
        case "bash":
          return this.bash.execute(String(args.command || ""));
        case "search":
          return this.search.search(String(args.query || ""), {
            searchType: (args.search_type as "text" | "files" | "both" | undefined) ?? "both",
            includePattern: typeof args.include_pattern === "string" ? args.include_pattern : undefined,
            excludePattern: typeof args.exclude_pattern === "string" ? args.exclude_pattern : undefined,
            caseSensitive: typeof args.case_sensitive === "boolean" ? args.case_sensitive : undefined,
            wholeWord: typeof args.whole_word === "boolean" ? args.whole_word : undefined,
            regex: typeof args.regex === "boolean" ? args.regex : undefined,
            maxResults: typeof args.max_results === "number" ? args.max_results : undefined,
            fileTypes: Array.isArray(args.file_types) ? args.file_types.map(String) : undefined,
            includeHidden: typeof args.include_hidden === "boolean" ? args.include_hidden : undefined,
          });
        case "create_todo_list":
          return this.todoTool.createTodoList((args.todos as never[]) || []);
        case "update_todo_list":
          return this.todoTool.updateTodoList((args.updates as never[]) || []);
        case "view_todo_list":
          return this.todoTool.viewTodoList();
        case "request_confirmation":
          return this.confirmationTool.requestConfirmation({
            operation: String(args.operation || "Confirm action"),
            filename: String(args.filename || ""),
            description: typeof args.description === "string" ? args.description : undefined,
            showVSCodeOpen: Boolean(args.show_vscode_open),
            autoAccept: Boolean(args.auto_accept),
          });
        case "check_session_acceptance":
          return this.confirmationTool.checkSessionAcceptance();
        case "edit_file":
          if (!this.morphEditor) {
            return { success: false, error: "Morph editor is not configured" };
          }
          return this.morphEditor.editFile(
            String(args.target_file || ""),
            String(args.instructions || ""),
            String(args.code_edit || "")
          );
        default: {
          if (toolCall.function.name.startsWith("mcp__")) {
            const response = await getMCPManager().callTool(toolCall.function.name, args);
            return { success: true, output: JSON.stringify(response.content, null, 2), data: response.content };
          }
          return { success: false, error: `Unknown tool: ${toolCall.function.name}` };
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private toViewRange(startLine: unknown, endLine: unknown): [number, number] | undefined {
    if (typeof startLine === "number" && typeof endLine === "number") {
      return [startLine, endLine];
    }
    return undefined;
  }

  getChatHistory(): ChatEntry[] {
    return [...this.chatHistory];
  }

  getCurrentModel(): string {
    return this.grokClient.getCurrentModel();
  }

  setModel(model: string): void {
    this.grokClient.setModel(model);
  }

  abortCurrentOperation(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async executeBashCommand(command: string): Promise<ToolResult> {
    return this.bash.execute(command);
  }

  async delegate(task: Record<string, unknown>): Promise<TaskResult> {
    if (!this.supervisor) {
      return { success: false, error: "Supervisor is disabled for this agent instance" };
    }

    const typedTask = {
      id: String(task.id || `task_${Date.now()}`),
      type: (task.type as "edit" | "git" | "search" | "mcp" | "reason") || "reason",
      payload: (task.payload as Record<string, unknown>) || task,
      priority: typeof task.priority === "number" ? task.priority : 0,
      context: (task.context as Record<string, unknown> | undefined) || undefined,
    };

    return this.supervisor.executeTask(typedTask);
  }
}
