import OpenAI from "openai";

export type GrokMessage = any;
export interface GrokTool { /* ... */ }
export interface GrokToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export class GrokClient {
  private client: OpenAI;
  private currentModel: string = "grok-420";

  constructor(apiKey: string, model?: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseURL || "https://api.x.ai/v1" });
    if (model) this.currentModel = model;
  }

  setModel(model: string): void { this.currentModel = model; }
  getCurrentModel(): string { return this.currentModel; }

  async listModels(): Promise<any> {
    return this.client.models.list();
  }

  // Keep your original chat, chatStream methods here (unchanged)
}
