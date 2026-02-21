import fs from "fs-extra";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger.js";

const SETTINGS_VERSION = 4;
const MAX_SETTINGS_FILE_BYTES = 1_000_000;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function toSafeObjectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return Object.create(null) as Record<string, unknown>;
  }

  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!BLOCKED_OBJECT_KEYS.has(key)) {
      output[key] = entry;
    }
  }
  return output;
}


export interface UserSettings {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  models?: string[];
  autoDiscover?: boolean;
  settingsVersion?: number;
  trustedMcpServers?: Record<string, string>;
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
  if (record.trustedMcpServers && typeof record.trustedMcpServers === "object") {
    sanitized.trustedMcpServers = Object.fromEntries(
      Object.entries(toSafeObjectRecord(record.trustedMcpServers)).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  }

  return sanitized;
}



function writeJsonFileSyncAtomic(filePath: string, value: object): void {
  const dir = path.dirname(filePath);
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tempFilePath = `${filePath}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  fsSync.writeFileSync(tempFilePath, serialized, { encoding: "utf-8", mode: 0o600 });
  fsSync.renameSync(tempFilePath, filePath);
}

async function ensureSecureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await fs.stat(dir);
  const currentMode = stats.mode & 0o777;
  if ((currentMode & 0o077) !== 0) {
    await fs.chmod(dir, 0o700);
  }
}

function sanitizeProjectSettings(value: unknown): Partial<ProjectSettings> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const sanitized: Partial<ProjectSettings> = {};
  if (typeof record.model === "string") sanitized.model = record.model;
  if (record.mcpServers && typeof record.mcpServers === "object") sanitized.mcpServers = toSafeObjectRecord(record.mcpServers);
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
  private lastWriteError: Error | null = null;

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

    const stats = fsSync.statSync(filePath);
    if (stats.size > MAX_SETTINGS_FILE_BYTES) {
      throw new Error(`Settings file is too large: ${filePath}`);
    }

    const content = fsSync.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as unknown;
  }

  private enqueueWrite(filePath: string, value: object): Promise<void> {
    const operation = this.writeQueue.then(async () => {
        const dir = path.dirname(filePath);
        await ensureSecureDirectory(dir);

        const tempFilePath = `${filePath}.tmp`;
        const serialized = JSON.stringify(value, null, 2);
        await fs.writeFile(tempFilePath, serialized, { encoding: "utf-8", mode: 0o600 });
        await fs.move(tempFilePath, filePath, { overwrite: true });
      });

    this.writeQueue = operation
      .then(() => {
        this.lastWriteError = null;
      })
      .catch((error: unknown) => {
        this.lastWriteError = error instanceof Error ? error : new Error(String(error));
        logger.warn("settings-write-failed", {
          component: "settings-manager",
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return operation;
  }

  public loadUserSettings(forceReload = false): UserSettings {
    if (this.userSettingsCache && !forceReload) {
      return { ...this.userSettingsCache };
    }
    try {
      const rawSettings = this.readJsonFile(this.userSettingsPath);
      if (!rawSettings) {
        const mergedDefaults = { ...DEFAULT_USER_SETTINGS };
        writeJsonFileSyncAtomic(this.userSettingsPath, mergedDefaults);
        this.userSettingsCache = mergedDefaults;
        return mergedDefaults;
      }

      const settings = sanitizeUserSettings(rawSettings);

      if (typeof settings.apiKey === "string" && settings.apiKey.length > 0) {
        this.sessionApiKey = settings.apiKey;
        const { apiKey, ...sanitized } = settings;
        void apiKey;
        const merged = { ...DEFAULT_USER_SETTINGS, ...sanitized };
        writeJsonFileSyncAtomic(this.userSettingsPath, merged);
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

  public async saveUserSettings(settings: Partial<UserSettings>): Promise<void> {
    const current = this.userSettingsCache ? sanitizeUserSettings(this.userSettingsCache) : sanitizeUserSettings(this.readJsonFile(this.userSettingsPath));
    const merged = { ...DEFAULT_USER_SETTINGS, ...current, ...sanitizeUserSettings(settings) };
    if (typeof merged.apiKey === "string") {
      this.sessionApiKey = merged.apiKey;
      delete merged.apiKey;
    }

    await this.enqueueWrite(this.userSettingsPath, merged);
    this.userSettingsCache = merged;
  }

  public getCurrentModel(): string {
    return this.loadProjectSettings().model || this.loadUserSettings().defaultModel || "grok-420";
  }

  public async setCurrentModel(model: string): Promise<void> {
    await this.updateProjectSetting("model", model);
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

  public async updateUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): Promise<void> {
    if (key === "apiKey" && typeof value === "string") {
      this.sessionApiKey = value;
      const current = this.userSettingsCache ? sanitizeUserSettings(this.userSettingsCache) : sanitizeUserSettings(this.readJsonFile(this.userSettingsPath));
      if (typeof current.apiKey === "string") {
        delete current.apiKey;
        await this.enqueueWrite(this.userSettingsPath, current);
        this.userSettingsCache = { ...DEFAULT_USER_SETTINGS, ...current };
      }
      return;
    }

    await this.saveUserSettings({ [key]: value });
  }

  public loadProjectSettings(forceReload = false): ProjectSettings {
    if (this.projectSettingsCache && !forceReload) {
      return { ...this.projectSettingsCache };
    }

    try {
      const rawSettings = this.readJsonFile(this.projectSettingsPath);
      if (!rawSettings) {
        const mergedDefaults = { ...DEFAULT_PROJECT_SETTINGS };
        writeJsonFileSyncAtomic(this.projectSettingsPath, mergedDefaults);
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

  public async saveProjectSettings(settings: Partial<ProjectSettings>): Promise<void> {
    const current = this.projectSettingsCache ? sanitizeProjectSettings(this.projectSettingsCache) : sanitizeProjectSettings(this.readJsonFile(this.projectSettingsPath));
    const merged = { ...DEFAULT_PROJECT_SETTINGS, ...current, ...sanitizeProjectSettings(settings) };
    await this.enqueueWrite(this.projectSettingsPath, merged);
    this.projectSettingsCache = merged;
  }

  public async updateProjectSetting<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): Promise<void> {
    await this.saveProjectSettings({ [key]: value });
  }

  public async flushWrites(): Promise<void> {
    await this.writeQueue;
    if (this.lastWriteError) {
      throw this.lastWriteError;
    }
  }
}

export function getSettingsManager(): SettingsManager {
  return SettingsManager.getInstance();
}
