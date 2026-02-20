export interface RuntimeConfig {
  grokApiKey: string;
  grokBaseUrl?: string;
}

function readEnvString(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const grokApiKey = readEnvString("GROK_API_KEY");
  if (!grokApiKey) {
    throw new Error("GROK_API_KEY is required");
  }

  return {
    grokApiKey,
    grokBaseUrl: readEnvString("GROK_BASE_URL"),
  };
}
