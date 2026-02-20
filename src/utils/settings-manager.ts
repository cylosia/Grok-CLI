import fs from "fs-extra";
import * as fsSync from "fs";
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


function sanitizeUserSettings(value: unknown): Partial<UserSettings> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sanitized: Partial<UserSettings> = {};

  if (typeof record.apiKey === "string") sanitized.apiKey = record.apiKey;
  if (typeof record.baseURL === "string") sanitized.baseURL = record.baseURL;
  if (typeof record.defaultModel === "string") sanitized.defaultModel = record.defaultModel;
  if (Array.isArray(record.models) && record.models.every((m) => typeof m === "string")) sanitized.models = record.models;
  if (typeof record.autoDiscover === "boolean") sanitized.autoDiscover = record.autoDiscover;
  if (typeof record.settingsVersion === "number") sanitized.settingsVersion = record.settingsVersion;

  return sanitized;
}

function sanitizeProjectSettings(value: unknown): Partial<ProjectSettings> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sanitized: Partial<ProjectSettings> = {};
  if (typeof record.model === "string") sanitized.model = record.model;
  if (record.mcpServers && typeof record.mcpServers === "object") sanitized.mcpServers = record.mcpServers as Record<string, unknown>;
  if (record.trustedMcpServers && typeof record.trustedMcpServers === "object") {
    sanitized.trustedMcpServers = Object.fromEntries(
      Object.entries(record.trustedMcpServers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  }
  return sanitized;
}

export class SettingsManager {
  private static instance: SettingsManager;
  private userSettingsPath: string;
  private projectSettingsPath: string;
  private sessionApiKey: string | undefined;
  private userSettingsCache: UserSettings | null = null;
  private projectSettingsCache: ProjectSettings | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor() {
    this.userSettingsPath = path.join(os.homedir(), ".grok", "user-settings.json");
    this.projectSettingsPath = path.join(process.cwd(), ".grok", "settings.json");
  }

  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) SettingsManager.instance = new SettingsManager();
    return SettingsManager.instance;
  }

  private readJsonFile(filePath: string): unknown | null {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }

    const content = fsSync.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as unknown;
  }

  private enqueueWrite(filePath: string, value: object): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        const dir = path.dirname(filePath);
        await fs.ensureDir(dir);

        const tempFilePath = `${filePath}.tmp`;
        const serialized = JSON.stringify(value, null, 2);
        await fs.writeFile(tempFilePath, serialized, { encoding: "utf-8", mode: 0o600 });
        await fs.move(tempFilePath, filePath, { overwrite: true });
      })
      .catch((error: unknown) => {
        logger.warn("settings-write-failed", {
          component: "settings-manager",
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  public loadUserSettings(forceReload = false): UserSettings {
    if (this.userSettingsCache && !forceReload) {
      return { ...this.userSettingsCache };
    }
    try {
      const rawSettings = this.readJsonFile(this.userSettingsPath);
      if (!rawSettings) {
        const mergedDefaults = { ...DEFAULT_USER_SETTINGS };
        this.enqueueWrite(this.userSettingsPath, mergedDefaults);
        this.userSettingsCache = mergedDefaults;
        return mergedDefaults;
      }

      const settings = sanitizeUserSettings(rawSettings);

      if (typeof settings.apiKey === "string" && settings.apiKey.length > 0) {
        this.sessionApiKey = settings.apiKey;
        const { apiKey, ...sanitized } = settings;
        void apiKey;
        const merged = { ...DEFAULT_USER_SETTINGS, ...sanitized };
        this.enqueueWrite(this.userSettingsPath, merged);
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
    const current = sanitizeUserSettings(this.readJsonFile(this.userSettingsPath));
    const merged = { ...DEFAULT_USER_SETTINGS, ...current, ...sanitizeUserSettings(settings) };
    if (typeof merged.apiKey === "string") {
      this.sessionApiKey = merged.apiKey;
      delete merged.apiKey;
    }

    this.enqueueWrite(this.userSettingsPath, merged);
    this.userSettingsCache = merged;
  }

  public getCurrentModel(): string {
    return this.loadProjectSettings().model || this.loadUserSettings().defaultModel || "grok-420";
  }

  public setCurrentModel(model: string): void {
    this.updateProjectSetting("model", model);
  }

  public getAvailableModels(): string[] {
    return this.loadUserSettings().models || DEFAULT_USER_SETTINGS.models || [];
  }

  public getApiKey(): string | undefined {
    return process.env.GROK_API_KEY || this.sessionApiKey || this.loadUserSettings().apiKey;
  }

  public getBaseURL(): string {
    return process.env.GROK_BASE_URL || this.loadUserSettings().baseURL || DEFAULT_USER_SETTINGS.baseURL || "https://api.x.ai/v1";
  }

  public updateUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    if (key === "apiKey" && typeof value === "string") {
      this.sessionApiKey = value;
      const current = sanitizeUserSettings(this.readJsonFile(this.userSettingsPath));
      if (typeof current.apiKey === "string") {
        delete current.apiKey;
        this.enqueueWrite(this.userSettingsPath, current);
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
      const rawSettings = this.readJsonFile(this.projectSettingsPath);
      if (!rawSettings) {
        const mergedDefaults = { ...DEFAULT_PROJECT_SETTINGS };
        this.enqueueWrite(this.projectSettingsPath, mergedDefaults);
        this.projectSettingsCache = mergedDefaults;
        return mergedDefaults;
      }

      const settings = sanitizeProjectSettings(rawSettings);
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
    const current = sanitizeProjectSettings(this.readJsonFile(this.projectSettingsPath));
    const merged = { ...DEFAULT_PROJECT_SETTINGS, ...current, ...sanitizeProjectSettings(settings) };
    this.enqueueWrite(this.projectSettingsPath, merged);
    this.projectSettingsCache = merged;
  }

  public updateProjectSetting<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    this.saveProjectSettings({ [key]: value });
  }
}

export function getSettingsManager(): SettingsManager {
  return SettingsManager.getInstance();
}
