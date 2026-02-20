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

  // ==================== USER SETTINGS ====================
  public loadUserSettings(): UserSettings {
    try {
      if (!fs.existsSync(this.userSettingsPath)) {
        this.saveUserSettings(DEFAULT_USER_SETTINGS);
        return DEFAULT_USER_SETTINGS;
      }
      const content = fs.readFileSync(this.userSettingsPath, "utf-8");
      const settings = JSON.parse(content);
      return { ...DEFAULT_USER_SETTINGS, ...settings };
    } catch {
      return DEFAULT_USER_SETTINGS;
    }
  }

  public saveUserSettings(settings: Partial<UserSettings>): void {
    const dir = path.dirname(this.userSettingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.userSettingsPath, JSON.stringify({ ...this.loadUserSettings(), ...settings }, null, 2));
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
      if (!fs.existsSync(this.projectSettingsPath)) {
        this.saveProjectSettings(DEFAULT_PROJECT_SETTINGS);
        return DEFAULT_PROJECT_SETTINGS;
      }
      const content = fs.readFileSync(this.projectSettingsPath, "utf-8");
      return { ...DEFAULT_PROJECT_SETTINGS, ...JSON.parse(content) };
    } catch {
      return DEFAULT_PROJECT_SETTINGS;
    }
  }

  public saveProjectSettings(settings: Partial<ProjectSettings>): void {
    const dir = path.dirname(this.projectSettingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.projectSettingsPath, JSON.stringify({ ...this.loadProjectSettings(), ...settings }, null, 2));
  }

  public updateProjectSetting<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    this.saveProjectSettings({ [key]: value });
  }
}

export function getSettingsManager(): SettingsManager {
  return SettingsManager.getInstance();
}
