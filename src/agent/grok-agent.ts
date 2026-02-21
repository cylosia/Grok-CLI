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
import { TaskId, ToolResult } from "../types/index.js";
import { createTokenCounter, TokenCounter } from "../utils/token-counter.js";
import { loadCustomInstructions } from "../utils/custom-instructions.js";
import { getSettingsManager } from "../utils/settings-manager.js";
import { AgentSupervisor, TaskResult } from "./supervisor.js";


const MAX_TOOL_ARGS_BYTES = 100_000;
const MAX_CHAT_HISTORY_ENTRIES = 500;
const MAX_MESSAGE_ENTRIES = 500;

function isTodoItem(value: unknown): value is { id: string; content: string; status: "pending" | "in_progress" | "completed"; priority: "high" | "medium" | "low" } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.content === "string"
    && (record.status === "pending" || record.status === "in_progress" || record.status === "completed")
    && (record.priority === "high" || record.priority === "medium" || record.priority === "low");
}

function isTodoUpdate(value: unknown): value is { id: string; status?: "pending" | "in_progress" | "completed"; content?: string; priority?: "high" | "medium" | "low" } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && (record.status === undefined || record.status === "pending" || record.status === "in_progress" || record.status === "completed")
    && (record.content === undefined || typeof record.content === "string")
    && (record.priority === undefined || record.priority === "high" || record.priority === "medium" || record.priority === "low");
}

function parseToolArgs(argsRaw: string): Record<string, unknown> {
  if (argsRaw.length > MAX_TOOL_ARGS_BYTES) {
    throw new Error(`Tool arguments exceed ${MAX_TOOL_ARGS_BYTES} bytes`);
  }

  const parsed = JSON.parse(argsRaw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

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
  private mcpInitError: string | null = null;
  private maxToolRounds: number;
  private supervisor: AgentSupervisor | null;
  private processingQueue: Promise<void> = Promise.resolve();
  private isProcessing = false;

  private trimBuffers(): void {
    if (this.chatHistory.length > MAX_CHAT_HISTORY_ENTRIES) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY_ENTRIES);
    }
    if (this.messages.length > MAX_MESSAGE_ENTRIES) {
      const systemMessage = this.messages[0];
      const tail = this.messages.slice(-(MAX_MESSAGE_ENTRIES - 1));
      this.messages = systemMessage ? [systemMessage, ...tail] : tail;
    }
  }

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
      this.mcpInitError = null;
    } catch (error) {
      this.mcpInitialized = false;
      this.mcpInitError = error instanceof Error ? error.message : String(error);
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isProcessing) {
      throw new Error("Agent is already processing another request");
    }
    const previous = this.processingQueue;
    let release: () => void = () => {};
    this.processingQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.isProcessing = true;
    try {
      return await operation();
    } finally {
      this.isProcessing = false;
      release();
    }
  }

  async processUserMessage(message: string): Promise<ChatEntry[]> {
    return this.runExclusive(async () => {
    const entries: ChatEntry[] = [];
    const userEntry: ChatEntry = {
      type: "user",
      content: message,
      timestamp: new Date(),
    };

    this.chatHistory.push(userEntry);
    this.trimBuffers();
    entries.push(userEntry);
    this.messages.push({ role: "user", content: message });
    this.trimBuffers();

    this.abortController = new AbortController();
    const tools = await getAllGrokTools();
    let toolRounds = 0;

    while (toolRounds < this.maxToolRounds) {
      const assistantMessage = await this.grokClient.chat(this.messages, {
        tools,
        signal: this.abortController.signal,
      });

      this.messages.push(assistantMessage);
      this.trimBuffers();

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
          this.trimBuffers();

          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.success
              ? result.output || JSON.stringify(result.data || {})
              : result.error || "Tool failed",
          });
          this.trimBuffers();
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
      this.trimBuffers();
      return entries;
    }

    const failEntry: ChatEntry = {
      type: "assistant",
      content: "Stopped after reaching maximum tool rounds.",
      timestamp: new Date(),
    };
    this.chatHistory.push(failEntry);
    this.trimBuffers();
    entries.push(failEntry);
    return entries;
    });
  }

  async *processUserMessageStream(message: string): AsyncGenerator<StreamingChunk> {
    if (this.isProcessing) {
      throw new Error("Agent is already processing another request");
    }
    this.isProcessing = true;
    const userEntry: ChatEntry = {
      type: "user",
      content: message,
      timestamp: new Date(),
    };
    this.chatHistory.push(userEntry);
    this.messages.push({ role: "user", content: message });
    this.trimBuffers();

    const totalTokens = this.tokenCounter.countTokens(message);
    yield { type: "token_count", tokenCount: totalTokens };

    this.abortController = new AbortController();
    const tools: GrokTool[] = await getAllGrokTools();
    let toolRounds = 0;

    try {
      while (toolRounds < this.maxToolRounds) {
        const assistantParts: string[] = [];
        let latestToolCalls: GrokToolCall[] = [];

        for await (const chunk of this.grokClient.chatStream(this.messages, {
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
        this.messages.push({
          role: "assistant",
          content: assistantContent,
          ...(latestToolCalls.length > 0 ? { tool_calls: latestToolCalls } : {}),
        });
        this.chatHistory.push({
          type: "assistant",
          content: assistantContent,
          timestamp: new Date(),
          ...(latestToolCalls.length > 0 ? { toolCalls: latestToolCalls } : {}),
        });
        this.trimBuffers();

        if (latestToolCalls.length === 0) {
          yield { type: "done" };
          return;
        }

        for (const toolCall of latestToolCalls) {
          const toolResult = await this.executeTool(toolCall);
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult.success
              ? toolResult.output || JSON.stringify(toolResult.data || {})
              : toolResult.error || "Tool failed",
          });
          this.chatHistory.push({
            type: "tool_result",
            content: toolResult.success ? toolResult.output || "Success" : toolResult.error || "Tool failed",
            timestamp: new Date(),
            toolCall,
            toolResult,
          });
          this.trimBuffers();
          yield { type: "tool_result", toolCall, toolResult };
        }

        toolRounds += 1;
      }
      yield { type: "content", content: "Stopped after reaching maximum tool rounds." };
      yield { type: "done" };
    } finally {
      this.isProcessing = false;
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

    const typedTask = {
      id: (task.id || `task_${Date.now()}`) as TaskId,
      type: task.type || "reason",
      payload: task.payload || {},
      priority: typeof task.priority === "number" ? task.priority : 0,
      ...(task.context ? { context: task.context } : {}),
    };

    return this.supervisor.executeTask(typedTask);
  }
}
