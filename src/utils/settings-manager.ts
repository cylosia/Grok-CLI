import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SETTINGS_VERSION = 4;

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
  mcpServers?: Record<string, unknown>;
  trustedMcpServers?: Record<string, string>;
}

const DEFAULT_USER_SETTINGS: UserSettings = {
  baseURL: "https://api.x.ai/v1",
  defaultModel: "grok-420",
  autoDiscover: true,
  models: [
    "grok-420", "grok-4.20-beta", "grok-420-heavy", "grok-4.20-heavy",
    "grok-4-1-fast-reasoning", "grok-4-1-fast-non-reasoning", "grok-code-fast-1"
  ],
  settingsVersion: SETTINGS_VERSION,
};

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  model: "grok-420",
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

  private readJsonFile<T extends object>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  }

  private writeJsonFile(filePath: string, value: object): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  // ==================== USER SETTINGS ====================
  public loadUserSettings(): UserSettings {
    try {
      const settings = this.readJsonFile<Partial<UserSettings>>(this.userSettingsPath);
      if (!settings) {
        const mergedDefaults = { ...DEFAULT_USER_SETTINGS };
        this.writeJsonFile(this.userSettingsPath, mergedDefaults);
        return mergedDefaults;
      }

      return { ...DEFAULT_USER_SETTINGS, ...settings };
    } catch (error) {
      console.warn(`Failed to load user settings: ${error instanceof Error ? error.message : String(error)}`);
      return DEFAULT_USER_SETTINGS;
    }
  }

  public saveUserSettings(settings: Partial<UserSettings>): void {
    const current = this.readJsonFile<Partial<UserSettings>>(this.userSettingsPath) || DEFAULT_USER_SETTINGS;
    this.writeJsonFile(this.userSettingsPath, { ...DEFAULT_USER_SETTINGS, ...current, ...settings });
  }

  public getCurrentModel(): string {
    return this.loadProjectSettings().model || this.loadUserSettings().defaultModel || "grok-420";
  }

  public setCurrentModel(model: string): void {
    this.updateProjectSetting("model", model);
  }

  public getAvailableModels(): string[] {
    return this.loadUserSettings().models || DEFAULT_USER_SETTINGS.models!;
  }

  public getApiKey(): string | undefined {
    return process.env.GROK_API_KEY || this.loadUserSettings().apiKey;
  }

  public getBaseURL(): string {
    return process.env.GROK_BASE_URL || this.loadUserSettings().baseURL || DEFAULT_USER_SETTINGS.baseURL!;
  }

  public updateUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    this.saveUserSettings({ [key]: value });
  }

  // ==================== PROJECT SETTINGS ====================
  public loadProjectSettings(): ProjectSettings {
    try {
      const settings = this.readJsonFile<Partial<ProjectSettings>>(this.projectSettingsPath);
      if (!settings) {
        const mergedDefaults = { ...DEFAULT_PROJECT_SETTINGS };
        this.writeJsonFile(this.projectSettingsPath, mergedDefaults);
        return mergedDefaults;
      }

      return { ...DEFAULT_PROJECT_SETTINGS, ...settings };
    } catch (error) {
      console.warn(`Failed to load project settings: ${error instanceof Error ? error.message : String(error)}`);
      return DEFAULT_PROJECT_SETTINGS;
    }
  }

  public saveProjectSettings(settings: Partial<ProjectSettings>): void {
    const current = this.readJsonFile<Partial<ProjectSettings>>(this.projectSettingsPath) || DEFAULT_PROJECT_SETTINGS;
    this.writeJsonFile(this.projectSettingsPath, { ...DEFAULT_PROJECT_SETTINGS, ...current, ...settings });
  }

  public updateProjectSetting<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    this.saveProjectSettings({ [key]: value });
  }
}

export function getSettingsManager(): SettingsManager {
  return SettingsManager.getInstance();
}
