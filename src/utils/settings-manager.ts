import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SETTINGS_VERSION = 4;   // ← BUMPED FOR v2.0

export interface UserSettings {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  models?: string[];
  autoDiscover?: boolean;
  settingsVersion?: number;
}

export interface ProjectSettings {
  model?: string;
  mcpServers?: Record<string, any>;
}

const DEFAULT_USER_SETTINGS: Partial<UserSettings> = {
  baseURL: "https://api.x.ai/v1",
  defaultModel: "grok-420",
  autoDiscover: true,
  models: [
    // Grok 4.20 Family (Feb 2026)
    "grok-420",
    "grok-4.20-beta",
    "grok-420-heavy",
    "grok-4.20-heavy",
    // Previous generation
    "grok-4-1-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-code-fast-1",
  ],
};

export class SettingsManager {
  private static instance: SettingsManager;
  private userSettingsPath: string;
  private projectSettingsPath: string;

  private constructor() {
    this.userSettingsPath = path.join(os.homedir(), ".grok", "user-settings.json");
    this.projectSettingsPath = path.join(process.cwd(), ".grok", "settings.json");
  }

  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) SettingsManager.instance = new SettingsManager();
    return SettingsManager.instance;
  }

  public async getAvailableModels(): Promise<string[]> {
    const settings = this.loadUserSettings();
    if (settings.autoDiscover) {
      const discovered = await this.discoverModels();
      return [...new Set([...discovered, ...(settings.models || [])])];
    }
    return settings.models || DEFAULT_USER_SETTINGS.models!;
  }

  private async discoverModels(): Promise<string[]> {
    // Will call /v1/models + Ollama detection in next PR
    return [];
  }

  // ... rest of class unchanged (migration logic already handles v4)
}

export function getSettingsManager(): SettingsManager {
  return SettingsManager.getInstance();
}
