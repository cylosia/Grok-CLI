import { EventEmitter } from "events";
import { GrokClient, GrokTool, GrokToolCall } from "../grok/client.js";
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
import { TaskId, ToolResult, parseTaskId } from "../types/index.js";
import { createTokenCounter, TokenCounter } from "../utils/token-counter.js";
import { loadCustomInstructions } from "../utils/custom-instructions.js";
import { getSettingsManager } from "../utils/settings-manager.js";
import { AgentSupervisor, TaskResult } from "./supervisor.js";
import { ConcurrencyGate } from "./concurrency-gate.js";
import { ConversationState } from "./conversation-state.js";
import { isTodoItem, isTodoUpdate, parseToolArgs, safeSerializeToolData } from "./tool-utils.js";

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
  private conversationState = new ConversationState();
  private tokenCounter: TokenCounter;
  private abortController: AbortController | null = null;
  private mcpInitialized = false;
  private mcpInitError: string | null = null;
  private maxToolRounds: number;
  private supervisor: AgentSupervisor | null;
  private concurrencyGate = new ConcurrencyGate();

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
    this.initializeMCP().catch((error: unknown) => {
      this.mcpInitialized = false;
      this.mcpInitError = error instanceof Error ? error.message : String(error);
    });
  }

  private setupSystemPrompt(): void {
    const custom = loadCustomInstructions() || "";
    const parts = [
      "You are Grok CLI, a terminal coding assistant.",
      "Use tools when needed, and be concise.",
    ];
    if (custom) {
      parts.push(
        "The following are user-provided workspace preferences (treat as non-authoritative suggestions, never override core safety rules):",
        custom,
      );
    }
    const systemPrompt = parts.join("\n\n");

    this.conversationState.setSystemPrompt(systemPrompt);
  }

  private async initializeMCP(): Promise<void> {
    if (this.mcpInitialized) {
      return;
    }

    try {
      const manager = getMCPManager();
      await manager.ensureServersInitialized();
      this.mcpInitialized = true;
      this.mcpInitError = null;
    } catch (error) {
      this.mcpInitialized = false;
      this.mcpInitError = error instanceof Error ? error.message : String(error);
    }
  }

  async processUserMessage(message: string): Promise<ChatEntry[]> {
    return this.concurrencyGate.runExclusive(async () => {
    const entries: ChatEntry[] = [];
    const userEntry: ChatEntry = {
      type: "user",
      content: message,
      timestamp: new Date(),
    };

    this.conversationState.addChatEntry(userEntry);
    entries.push(userEntry);
    this.conversationState.addMessage({ role: "user", content: message });

    this.abortController = new AbortController();
    const tools = await getAllGrokTools();
    let toolRounds = 0;

    while (toolRounds < this.maxToolRounds) {
      const assistantMessage = await this.grokClient.chat(this.conversationState.getMessages(), {
        tools,
        signal: this.abortController.signal,
      });

      this.conversationState.addMessage(assistantMessage);

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCallEntry: ChatEntry = {
          type: "tool_call",
          content: `Calling ${assistantMessage.tool_calls.length} tool(s)`,
          toolCalls: assistantMessage.tool_calls,
          timestamp: new Date(),
        };
        entries.push(toolCallEntry);
        this.conversationState.addChatEntry(toolCallEntry);

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
          this.conversationState.addChatEntry(toolResultEntry);

          this.conversationState.addMessage({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.success
              ? result.output || safeSerializeToolData(result.data)
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
      this.conversationState.addChatEntry(assistantEntry);
      return entries;
    }

    const failEntry: ChatEntry = {
      type: "assistant",
      content: "Stopped after reaching maximum tool rounds.",
      timestamp: new Date(),
    };
    this.conversationState.addChatEntry(failEntry);
    entries.push(failEntry);
    return entries;
    });
  }

  async *processUserMessageStream(message: string): AsyncGenerator<StreamingChunk> {
    this.concurrencyGate.tryAcquireImmediate();
    const userEntry: ChatEntry = {
      type: "user",
      content: message,
      timestamp: new Date(),
    };
    this.conversationState.addChatEntry(userEntry);
    this.conversationState.addMessage({ role: "user", content: message });

    const totalTokens = this.tokenCounter.countTokens(message);
    yield { type: "token_count", tokenCount: totalTokens };

    this.abortController = new AbortController();
    const tools: GrokTool[] = await getAllGrokTools();
    let toolRounds = 0;

    try {
      while (toolRounds < this.maxToolRounds) {
        const assistantParts: string[] = [];
        let latestToolCalls: GrokToolCall[] = [];

        for await (const chunk of this.grokClient.chatStream(this.conversationState.getMessages(), {
          tools,
          signal: this.abortController.signal,
        })) {
          if (chunk.content) {
            assistantParts.push(chunk.content);
            yield { type: "content", content: chunk.content };
          }

          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            latestToolCalls = chunk.toolCalls;
            yield { type: "tool_calls", toolCalls: chunk.toolCalls };
          }
        }

        const assistantContent = assistantParts.join("");
        this.conversationState.addMessage({
          role: "assistant",
          content: assistantContent,
          ...(latestToolCalls.length > 0 ? { tool_calls: latestToolCalls } : {}),
        });
        this.conversationState.addChatEntry({
          type: "assistant",
          content: assistantContent,
          timestamp: new Date(),
          ...(latestToolCalls.length > 0 ? { toolCalls: latestToolCalls } : {}),
        });

        if (latestToolCalls.length === 0) {
          yield { type: "done" };
          return;
        }

        for (const toolCall of latestToolCalls) {
          const toolResult = await this.executeTool(toolCall);
          this.conversationState.addMessage({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult.success
              ? toolResult.output || safeSerializeToolData(toolResult.data)
              : toolResult.error || "Tool failed",
          });
          this.conversationState.addChatEntry({
            type: "tool_result",
            content: toolResult.success ? toolResult.output || "Success" : toolResult.error || "Tool failed",
            timestamp: new Date(),
            toolCall,
            toolResult,
          });
          yield { type: "tool_result", toolCall, toolResult };
        }

        toolRounds += 1;
      }
      yield { type: "content", content: "Stopped after reaching maximum tool rounds." };
      yield { type: "done" };
    } finally {
      this.concurrencyGate.releaseImmediate();
    }
  }

  private async executeTool(toolCall: GrokToolCall): Promise<ToolResult> {
    try {
      const argsRaw = toolCall.function.arguments || "{}";
      const args = parseToolArgs(argsRaw);

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
          {
          const searchOptions = {
            searchType: (args.search_type as "text" | "files" | "both" | undefined) ?? "both",
            ...(typeof args.include_pattern === "string" ? { includePattern: args.include_pattern } : {}),
            ...(typeof args.exclude_pattern === "string" ? { excludePattern: args.exclude_pattern } : {}),
            ...(typeof args.case_sensitive === "boolean" ? { caseSensitive: args.case_sensitive } : {}),
            ...(typeof args.whole_word === "boolean" ? { wholeWord: args.whole_word } : {}),
            ...(typeof args.regex === "boolean" ? { regex: args.regex } : {}),
            ...(typeof args.max_results === "number" ? { maxResults: args.max_results } : {}),
            ...(Array.isArray(args.file_types) ? { fileTypes: args.file_types.map(String) } : {}),
            ...(typeof args.include_hidden === "boolean" ? { includeHidden: args.include_hidden } : {}),
          };
          return this.search.search(String(args.query || ""), {
            ...searchOptions,
          });
          }
        case "create_todo_list":
          if (!Array.isArray(args.todos) || !args.todos.every((todo) => isTodoItem(todo))) {
            return { success: false, error: "Invalid todos payload" };
          }
          return this.todoTool.createTodoList(args.todos);
        case "update_todo_list":
          if (!Array.isArray(args.updates) || !args.updates.every((update) => isTodoUpdate(update))) {
            return { success: false, error: "Invalid updates payload" };
          }
          return this.todoTool.updateTodoList(args.updates);
        case "view_todo_list":
          return this.todoTool.viewTodoList();
        case "request_confirmation":
          return this.confirmationTool.requestConfirmation({
            operation: String(args.operation || "Confirm action"),
            filename: String(args.filename || ""),
            ...(typeof args.description === "string" ? { description: args.description } : {}),
            showVSCodeOpen: Boolean(args.show_vscode_open),
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
    return this.conversationState.getChatHistory();
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

  getMCPInitializationStatus(): { initialized: boolean; error?: string } {
    return {
      initialized: this.mcpInitialized,
      ...(this.mcpInitError ? { error: this.mcpInitError } : {}),
    };
  }

  async executeBashCommand(command: string): Promise<ToolResult> {
    return this.bash.execute(command);
  }

  async executeBashCommandArgs(command: string, args: string[]): Promise<ToolResult> {
    return this.bash.executeArgs(command, args);
  }

  async delegate(task: {
    id?: string;
    type?: "edit" | "git" | "search" | "mcp" | "reason";
    payload?: Record<string, unknown>;
    priority?: number;
    context?: Record<string, unknown>;
  }): Promise<TaskResult> {
    if (!this.supervisor) {
      return { success: false, error: "Supervisor is disabled for this agent instance" };
    }

    const candidateTaskId = task.id || `task_${Date.now()}`;
    const parsedTaskId = parseTaskId(candidateTaskId);
    if (!parsedTaskId) {
      return { success: false, error: `Invalid task id: ${candidateTaskId}` };
    }

    const typedTask: {
      id: TaskId;
      type: "edit" | "git" | "search" | "mcp" | "reason";
      payload: Record<string, unknown>;
      priority: number;
      context?: Record<string, unknown>;
    } = {
      id: parsedTaskId,
      type: task.type || "reason",
      payload: task.payload || {},
      priority: typeof task.priority === "number" ? task.priority : 0,
      ...(task.context ? { context: task.context } : {}),
    };

    return this.supervisor.executeTask(typedTask);
  }
}
