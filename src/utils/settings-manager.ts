import fs from "fs-extra";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger.js";

const SETTINGS_VERSION = 4;
const MAX_SETTINGS_FILE_BYTES = 1_000_000;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PRIVATE_HOST_PATTERN = /(^localhost$|\.local$)/i;
const DEFAULT_ALLOWED_BASE_URL_HOSTS = new Set(["api.x.ai"]);

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const segment of parts) {
    // Reject non-decimal representations (hex, octal, empty, whitespace)
    if (!/^\d{1,3}$/.test(segment)) {
      return null;
    }
    const value = Number(segment);
    if (value < 0 || value > 255) {
      return null;
    }
    nums.push(value);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateIpv4(host: string): boolean {
  const parsed = parseIpv4(host);
  if (!parsed) {
    return false;
  }
  const [a, b] = parsed;
  return a === 10
    || a === 127
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254);
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:");
}

function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOST_PATTERN.test(hostname)) {
    return true;
  }
  return hostname.includes(":") ? isPrivateIpv6(hostname) : isPrivateIpv4(hostname);
}

export function sanitizeAndValidateBaseUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  const parsed = new URL(trimmed);
  const scheme = parsed.protocol.toLowerCase();
  const allowInsecure = process.env.GROK_ALLOW_INSECURE_BASE_URL === "1";
  const allowPrivate = process.env.GROK_ALLOW_PRIVATE_BASE_URL === "1";

  if (scheme !== "https:" && !(allowInsecure && scheme === "http:")) {
    throw new Error(`Unsupported GROK base URL scheme: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("GROK base URL must not include URL credentials");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateHost(hostname) && !allowPrivate) {
    throw new Error("Private-network GROK base URL requires GROK_ALLOW_PRIVATE_BASE_URL=1");
  }

  const allowCustomHost = process.env.GROK_ALLOW_CUSTOM_BASE_URL_HOST === "1";
  if (!allowCustomHost && !DEFAULT_ALLOWED_BASE_URL_HOSTS.has(hostname)) {
    throw new Error("Custom GROK base URL hosts require GROK_ALLOW_CUSTOM_BASE_URL_HOST=1");
  }

  return parsed.toString();
}

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
  ensureSecureDirectorySync(dir);

  const tempDir = fsSync.mkdtempSync(path.join(dir, ".tmp-settings-"));
  const tempFilePath = path.join(tempDir, `${path.basename(filePath)}.${process.pid}.tmp`);
  const serialized = JSON.stringify(value, null, 2);
  const handle = fsSync.openSync(tempFilePath, "wx", 0o600);
  fsSync.writeFileSync(handle, serialized, { encoding: "utf-8" });
  fsSync.closeSync(handle);
  fsSync.renameSync(tempFilePath, filePath);
  fsSync.rmSync(tempDir, { recursive: true, force: true });
}

async function ensureSecureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(dir);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked settings directory: ${dir}`);
  }
  const currentMode = stats.mode & 0o777;
  if ((currentMode & 0o077) !== 0) {
    await fs.chmod(dir, 0o700);
  }
}

function ensureSecureDirectorySync(dir: string): void {
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = fsSync.lstatSync(dir);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked settings directory: ${dir}`);
  }
  const currentMode = stats.mode & 0o777;
  if ((currentMode & 0o077) !== 0) {
    fsSync.chmodSync(dir, 0o700);
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
  private static instancesByWorkspace = new Map<string, SettingsManager>();
  private static readonly MAX_WORKSPACE_INSTANCES = 64;
  private userSettingsPath: string;
  private projectSettingsPath: string;
  private sessionApiKey: string | undefined;
  private userSettingsCache: UserSettings | null = null;
  private projectSettingsCache: ProjectSettings | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingWriteCount = 0;
  private lastWriteError: Error | null = null;

  private constructor(private readonly workspaceRoot: string) {
    this.userSettingsPath = path.join(os.homedir(), ".grok", "user-settings.json");
    this.projectSettingsPath = path.join(workspaceRoot, ".grok", "settings.json");

    try {
      this.loadUserSettings();
      this.loadProjectSettings();
    } catch {
      // Lazily surfaced to callers on first explicit access.
    }
  }

  public static getInstance(workspaceRoot = process.cwd()): SettingsManager {
    const canonicalRoot = path.resolve(workspaceRoot);
    const existing = SettingsManager.instancesByWorkspace.get(canonicalRoot);
    if (existing) {
      return existing;
    }

    const next = new SettingsManager(canonicalRoot);
    if (SettingsManager.instancesByWorkspace.size >= SettingsManager.MAX_WORKSPACE_INSTANCES) {
      const oldestKey = SettingsManager.instancesByWorkspace.keys().next().value;
      if (typeof oldestKey === "string") {
        SettingsManager.instancesByWorkspace.delete(oldestKey);
      }
    }
    SettingsManager.instancesByWorkspace.set(canonicalRoot, next);
    return next;
  }

  private refreshProjectSettingsPath(): void {
    const nextPath = path.join(this.workspaceRoot, ".grok", "settings.json");
    if (nextPath !== this.projectSettingsPath) {
      this.projectSettingsPath = nextPath;
      this.projectSettingsCache = null;
    }
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
    this.pendingWriteCount += 1;
    const operation = this.writeQueue.then(async () => {
      const dir = path.dirname(filePath);
      await ensureSecureDirectory(dir);

      const tempDir = await fs.mkdtemp(path.join(dir, ".tmp-settings-"));
      try {
        const tempFilePath = path.join(tempDir, `${path.basename(filePath)}.${process.pid}.tmp`);
        const serialized = JSON.stringify(value, null, 2);
        await fs.writeFile(tempFilePath, serialized, { encoding: "utf-8", mode: 0o600, flag: "wx" });
        await fs.move(tempFilePath, filePath, { overwrite: true });
      } finally {
        await fs.remove(tempDir).catch(() => undefined);
      }
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
      })
      .finally(() => {
        this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
      });

    return operation;
  }

  public loadUserSettings(forceReload = false): UserSettings {
    if (this.userSettingsCache && !forceReload) {
      return { ...this.userSettingsCache };
    }
    if (forceReload && this.pendingWriteCount > 0) {
      throw new Error("Cannot force reload user settings while writes are pending; call flushWrites() first");
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
        const { apiKey: _apiKey, ...sanitized } = settings;
        const merged = { ...DEFAULT_USER_SETTINGS, ...sanitized };
        writeJsonFileSyncAtomic(this.userSettingsPath, merged);
        this.userSettingsCache = merged;
        return merged;
      }

      const merged = { ...DEFAULT_USER_SETTINGS, ...settings };
      this.userSettingsCache = merged;
      return merged;
    } catch (error) {
      logger.error("load-user-settings-failed", {
        component: "settings-manager",
        filePath: this.userSettingsPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
    const configured = process.env.GROK_BASE_URL || this.loadUserSettings().baseURL || DEFAULT_USER_SETTINGS.baseURL || "https://api.x.ai/v1";
    return sanitizeAndValidateBaseUrl(configured);
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
    this.refreshProjectSettingsPath();

    if (this.projectSettingsCache && !forceReload) {
      return { ...this.projectSettingsCache };
    }
    if (forceReload && this.pendingWriteCount > 0) {
      throw new Error("Cannot force reload project settings while writes are pending; call flushWrites() first");
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
      logger.error("load-project-settings-failed", {
        component: "settings-manager",
        filePath: this.projectSettingsPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async saveProjectSettings(settings: Partial<ProjectSettings>): Promise<void> {
    this.refreshProjectSettingsPath();
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

export function getSettingsManager(workspaceRoot = process.cwd()): SettingsManager {
  return SettingsManager.getInstance(workspaceRoot);
}
