import OpenAI from "openai";

export type GrokRole = "system" | "user" | "assistant" | "tool";

export interface GrokToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface GrokMessage {
  role: GrokRole;
  content?: string | null;
  tool_calls?: GrokToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface GrokTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  tools?: GrokTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

function toOpenAiMessages(messages: GrokMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      if (!message.tool_call_id || typeof message.content !== "string") {
        throw new Error("Tool messages require string content and tool_call_id");
      }
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
      } satisfies OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
    }

    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content ?? null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      } satisfies OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    }

    if (message.role === "user") {
      return {
        role: "user",
        content: message.content ?? "",
      } satisfies OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
    }

    return {
      role: "system",
      content: message.content ?? "",
    } satisfies OpenAI.Chat.Completions.ChatCompletionSystemMessageParam;
  });
}

function toOpenAiTools(tools?: GrokTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

function parseToolCalls(toolCalls: unknown): GrokToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  const parsed: GrokToolCall[] = [];
  for (const toolCall of toolCalls) {
    if (
      toolCall &&
      typeof toolCall === "object" &&
      "id" in toolCall &&
      "type" in toolCall &&
      "function" in toolCall
    ) {
      const call = toolCall as {
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (
        typeof call.id === "string" &&
        call.type === "function" &&
        call.function &&
        typeof call.function.name === "string" &&
        typeof call.function.arguments === "string"
      ) {
        parsed.push({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        });
      }
    }
  }
  return parsed;
}

export class GrokClient {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private client: OpenAI;
  private currentModel = "grok-420";

  constructor(apiKey: string, model?: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL || "https://api.x.ai/v1",
    });
    if (model) {
      this.currentModel = model;
    }
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  async listModels(): Promise<OpenAI.Models.Model[]> {
    const response = await this.withRetry(
      () => this.client.models.list({ timeout: GrokClient.REQUEST_TIMEOUT_MS }),
      3
    );
    return response.data;
  }

  async chat(messages: GrokMessage[], options: ChatOptions = {}): Promise<GrokMessage> {
    const convertedTools = toOpenAiTools(options.tools);
    const response = await this.withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.currentModel,
          messages: toOpenAiMessages(messages),
          ...(convertedTools ? { tools: convertedTools } : {}),
          ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
          ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        },
        { signal: options.signal, timeout: GrokClient.REQUEST_TIMEOUT_MS }
      ),
      3,
      options.signal
    );

    const message = response.choices[0]?.message;
    if (!message) {
      return { role: "assistant", content: "" };
    }

    const role: GrokRole = "assistant";

    return {
      role,
      content: typeof message.content === "string" ? message.content : null,
      ...(message.tool_calls ? { tool_calls: parseToolCalls(message.tool_calls) } : {}),
    };
  }

  async *chatStream(
    messages: GrokMessage[],
    options: ChatOptions = {}
  ): AsyncGenerator<{ content?: string; toolCalls?: GrokToolCall[]; done?: boolean }> {
    const convertedTools = toOpenAiTools(options.tools);
    const stream = await this.withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.currentModel,
          messages: toOpenAiMessages(messages),
          ...(convertedTools ? { tools: convertedTools } : {}),
          ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
          ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
          stream: true,
        },
        { signal: options.signal, timeout: GrokClient.REQUEST_TIMEOUT_MS }
      ),
      3,
      options.signal
    );

    const toolCalls: Record<number, GrokToolCall> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { content: delta.content };
      }

      if (delta.tool_calls) {
        for (const partial of delta.tool_calls) {
          if (typeof partial.index !== "number") continue;

          const existing = toolCalls[partial.index] ?? {
            id: partial.id ?? `tool_${partial.index}`,
            type: "function" as const,
            function: {
              name: partial.function?.name ?? "",
              arguments: partial.function?.arguments ?? "",
            },
          };

          if (partial.id) existing.id = partial.id;
          if (partial.function?.name) existing.function.name = partial.function.name;
          if (partial.function?.arguments) existing.function.arguments += partial.function.arguments;

          toolCalls[partial.index] = existing;
        }

        yield { toolCalls: Object.values(toolCalls) };
      }
    }

    yield { done: true };
  }

  private async withRetry<T>(operation: () => Promise<T>, maxAttempts = 3, signal?: AbortSignal): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        attempt += 1;

        if (attempt >= maxAttempts || !this.isRetryable(error)) {
          throw error;
        }

        const delayMs = 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
        await this.abortableSleep(delayMs, signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise<void>((resolve) => setTimeout(() => resolve(), delayMs));
    }
    if (signal.aborted) {
      return Promise.reject(new Error("Operation aborted"));
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Operation aborted"));
      };

      signal.addEventListener("abort", onAbort);
    });
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const status = (error as { status?: number }).status;
    return status === 429 || (typeof status === 'number' && status >= 500);
  }
}
