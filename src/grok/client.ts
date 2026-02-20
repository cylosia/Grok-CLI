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

export class GrokClient {
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
    const response = await this.client.models.list();
    return response.data;
  }

  async chat(messages: GrokMessage[], options: ChatOptions = {}): Promise<GrokMessage> {
    const response = await this.client.chat.completions.create({
      model: this.currentModel,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    }, {
      signal: options.signal,
    });

    const message = response.choices[0]?.message;
    if (!message) {
      return { role: "assistant", content: "" };
    }

    return {
      role: message.role as GrokRole,
      content: typeof message.content === "string" ? message.content : null,
      tool_calls: message.tool_calls as GrokToolCall[] | undefined,
    };
  }

  async *chatStream(messages: GrokMessage[], options: ChatOptions = {}): AsyncGenerator<{
    content?: string;
    toolCalls?: GrokToolCall[];
    done?: boolean;
  }> {
    const stream = await this.client.chat.completions.create({
      model: this.currentModel,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
    }, {
      signal: options.signal,
    });

    const toolCalls: Record<number, GrokToolCall> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) {
        continue;
      }

      if (delta.content) {
        yield { content: delta.content };
      }

      if (delta.tool_calls) {
        for (const partial of delta.tool_calls) {
          if (typeof partial.index !== "number") {
            continue;
          }

          const existing = toolCalls[partial.index] ?? {
            id: partial.id ?? `tool_${partial.index}`,
            type: "function",
            function: {
              name: partial.function?.name ?? "",
              arguments: partial.function?.arguments ?? "",
            },
          };

          if (partial.id) {
            existing.id = partial.id;
          }

          if (partial.function?.name) {
            existing.function.name = partial.function.name;
          }

          if (partial.function?.arguments) {
            existing.function.arguments += partial.function.arguments;
          }

          toolCalls[partial.index] = existing;
        }

        yield { toolCalls: Object.values(toolCalls) };
      }
    }

    yield { done: true };
  }
}
