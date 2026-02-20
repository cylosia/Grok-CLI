import axios from "axios";
import { GrokClient } from "./client.js";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export async function discoverModels(apiKey: string, baseURL?: string): Promise<ModelOption[]> {
  const client = new GrokClient(apiKey, undefined, baseURL);

  try {
    const models = await client.listModels();
    return models.map((m) => ({
      id: m.id,
      name: m.id,
      provider: "xai",
    }));
  } catch {
    return [
      { id: "grok-420", name: "Grok 4.20", provider: "xai" },
      { id: "grok-420-heavy", name: "Grok 4.20 Heavy", provider: "xai" },
    ];
  }
}

export async function detectOllamaModels(baseURL = "http://127.0.0.1:11434"): Promise<ModelOption[]> {
  try {
    const response = await axios.get<{ models: Array<{ name: string }> }>(`${baseURL}/api/tags`, {
      timeout: 2000,
    });

    const models = response.data.models || [];
    return models.map((m) => ({
      id: m.name,
      name: m.name,
      provider: "ollama",
    }));
  } catch {
    return [];
  }
}
