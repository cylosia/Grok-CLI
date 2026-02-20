import { GrokClient } from "./client.js";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export async function discoverModels(apiKey: string, baseURL?: string): Promise<ModelOption[]> {
  const client = new GrokClient(apiKey, undefined, baseURL);

  try {
    const response = await client.listModels();
    return response.data.map((m: any) => ({
      id: m.id,
      name: m.id,
      provider: "xai"
    }));
  } catch {
    // Fallback to static list
    return [
      { id: "grok-420", name: "Grok 4.20", provider: "xai" },
      { id: "grok-420-heavy", name: "Grok 4.20 Heavy", provider: "xai" },
    ];
  }
}

export async function detectOllamaModels(): Promise<ModelOption[]> {
  // Placeholder — full implementation coming in Phase 0 final PR
  return [];
}
