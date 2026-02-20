import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger.js";

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
  private sessionApiKey: string | undefined;
  private userSettingsCache: UserSettings | null = null;
  private projectSettingsCache: ProjectSettings | null = null;

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

    const tempFilePath = `${filePath}.tmp`;
    const serialized = JSON.stringify(value, null, 2);
    const fd = fs.openSync(tempFilePath, "w", 0o600);
    try {
      fs.writeFileSync(fd, serialized, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempFilePath, filePath);

    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  public loadUserSettings(forceReload = false): UserSettings {
    if (this.userSettingsCache && !forceReload) {
      return { ...this.userSettingsCache };
    }
    try {
      const settings = this.readJsonFile<Partial<UserSettings>>(this.userSettingsPath);
      if (!settings) {
        const mergedDefaults = { ...DEFAULT_USER_SETTINGS };
        this.writeJsonFile(this.userSettingsPath, mergedDefaults);
        this.userSettingsCache = mergedDefaults;
        return mergedDefaults;
      }

      if (typeof settings.apiKey === "string" && settings.apiKey.length > 0) {
        this.sessionApiKey = settings.apiKey;
        const { apiKey, ...sanitized } = settings;
        void apiKey;
        const merged = { ...DEFAULT_USER_SETTINGS, ...sanitized };
        this.writeJsonFile(this.userSettingsPath, merged);
        this.userSettingsCache = merged;
        return merged;
      }

      const merged = { ...DEFAULT_USER_SETTINGS, ...settings };
      this.userSettingsCache = merged;
      return merged;
    } catch (error) {
      logger.warn("load-user-settings-failed", {
        component: "settings-manager",
        error: error instanceof Error ? error.message : String(error),
      });
      this.userSettingsCache = { ...DEFAULT_USER_SETTINGS };
      return { ...DEFAULT_USER_SETTINGS };
    }
  }

  public saveUserSettings(settings: Partial<UserSettings>): void {
    const current = this.readJsonFile<Partial<UserSettings>>(this.userSettingsPath) || DEFAULT_USER_SETTINGS;
    const merged = { ...DEFAULT_USER_SETTINGS, ...current, ...settings };
    if (typeof merged.apiKey === "string") {
      this.sessionApiKey = merged.apiKey;
      delete merged.apiKey;
    }

    this.writeJsonFile(this.userSettingsPath, merged);
    this.userSettingsCache = merged;
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
    return process.env.GROK_API_KEY || this.sessionApiKey || this.loadUserSettings().apiKey;
  }

  public getBaseURL(): string {
    return process.env.GROK_BASE_URL || this.loadUserSettings().baseURL || DEFAULT_USER_SETTINGS.baseURL!;
  }

  public updateUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    if (key === "apiKey" && typeof value === "string") {
      this.sessionApiKey = value;
      const current = this.readJsonFile<Partial<UserSettings>>(this.userSettingsPath) || DEFAULT_USER_SETTINGS;
      if (typeof current.apiKey === "string") {
        delete current.apiKey;
        this.writeJsonFile(this.userSettingsPath, current);
        this.userSettingsCache = { ...DEFAULT_USER_SETTINGS, ...current };
      }
      return;
    }

    this.saveUserSettings({ [key]: value });
  }

  public loadProjectSettings(forceReload = false): ProjectSettings {
    if (this.projectSettingsCache && !forceReload) {
      return { ...this.projectSettingsCache };
    }

    try {
      const settings = this.readJsonFile<Partial<ProjectSettings>>(this.projectSettingsPath);
      if (!settings) {
        const mergedDefaults = { ...DEFAULT_PROJECT_SETTINGS };
        this.writeJsonFile(this.projectSettingsPath, mergedDefaults);
        this.projectSettingsCache = mergedDefaults;
        return mergedDefaults;
      }

      const merged = { ...DEFAULT_PROJECT_SETTINGS, ...settings };
      this.projectSettingsCache = merged;
      return merged;
    } catch (error) {
      logger.warn("load-project-settings-failed", {
        component: "settings-manager",
        error: error instanceof Error ? error.message : String(error),
      });
      this.projectSettingsCache = { ...DEFAULT_PROJECT_SETTINGS };
      return { ...DEFAULT_PROJECT_SETTINGS };
    }
  }

  public saveProjectSettings(settings: Partial<ProjectSettings>): void {
    const current = this.readJsonFile<Partial<ProjectSettings>>(this.projectSettingsPath) || DEFAULT_PROJECT_SETTINGS;
    const merged = { ...DEFAULT_PROJECT_SETTINGS, ...current, ...settings };
    this.writeJsonFile(this.projectSettingsPath, merged);
    this.projectSettingsCache = merged;
  }

  public updateProjectSetting<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    this.saveProjectSettings({ [key]: value });
  }
}

export function getSettingsManager(): SettingsManager {
  return SettingsManager.getInstance();
}
