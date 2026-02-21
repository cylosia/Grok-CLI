import axios from "axios";
import { GrokClient } from "./client.js";
import { logger } from "../utils/logger.js";

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
  } catch (error) {
    logger.warn("model-discovery-list-models-failed", {
      component: "model-discovery",
      provider: "xai",
      error: error instanceof Error ? error.message : String(error),
    });
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
  } catch (error) {
    logger.warn("model-discovery-ollama-detect-failed", {
      component: "model-discovery",
      provider: "ollama",
      baseURL,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
