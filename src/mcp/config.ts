import { getSettingsManager } from "../utils/settings-manager.js";
import { MCPServerConfig } from "./client.js";

export interface MCPConfig {
  servers: MCPServerConfig[];
}

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const BLOCKED_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeServerKey(value: string): boolean {
  return SERVER_NAME_PATTERN.test(value) && !BLOCKED_CONFIG_KEYS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseMCPServerConfig(value: unknown): MCPServerConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const { name, transport, command, args } = value;
  if (typeof name !== "string" || !isRecord(transport) || typeof transport.type !== "string") {
    return null;
  }

  if (command !== undefined && typeof command !== "string") {
    return null;
  }
  if (args !== undefined && !isStringArray(args)) {
    return null;
  }

  if (transport.type === "stdio") {
    if (typeof transport.command !== "string") {
      return null;
    }
    if (transport.args !== undefined && !isStringArray(transport.args)) {
      return null;
    }
  } else if (transport.type === "http" || transport.type === "sse") {
    if (typeof transport.url !== "string") {
      return null;
    }
  } else {
    return null;
  }

  const parsed: MCPServerConfig = {
    name,
    transport: {
      type: transport.type,
      ...(typeof transport.command === "string" ? { command: transport.command } : {}),
      ...(isStringArray(transport.args) ? { args: transport.args } : {}),
      ...(typeof transport.url === "string" ? { url: transport.url } : {}),
      ...(isRecord(transport.env) ? { env: Object.fromEntries(Object.entries(transport.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
      ...(isRecord(transport.headers) ? { headers: Object.fromEntries(Object.entries(transport.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
    },
    ...(typeof command === "string" ? { command } : {}),
    ...(isStringArray(args) ? { args } : {}),
  };

  return parsed;
}

export function loadMCPConfig(): MCPConfig {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const rawEntries = projectSettings.mcpServers ? Object.entries(projectSettings.mcpServers) : [];
  const rawServers = rawEntries
    .filter(([name]) => isSafeServerKey(name))
    .map(([, config]) => config);
  const servers = rawServers
    .map((server) => parseMCPServerConfig(server))
    .filter((server): server is MCPServerConfig => server !== null && isSafeServerKey(server.name));

  return { servers };
}

export async function addMCPServer(config: MCPServerConfig): Promise<void> {
  if (!isSafeServerKey(config.name)) {
    throw new Error(`Invalid MCP server name: ${config.name}`);
  }

  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const mcpServers = Object.assign(Object.create(null), projectSettings.mcpServers || {}) as Record<string, unknown>;
  mcpServers[config.name] = config;
  await manager.updateProjectSetting('mcpServers', mcpServers);
}

export async function removeMCPServer(serverName: string): Promise<void> {
  if (!isSafeServerKey(serverName)) {
    return;
  }

  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const mcpServers = Object.assign(Object.create(null), projectSettings.mcpServers || {}) as Record<string, unknown>;
  delete mcpServers[serverName];
  await manager.updateProjectSetting('mcpServers', mcpServers);
}

export function getTrustedMCPServerFingerprints(): Record<string, string> {
  const manager = getSettingsManager();
  const userSettings = manager.loadUserSettings();
  return userSettings.trustedMcpServers || {};
}

export async function setTrustedMCPServerFingerprint(serverName: string, fingerprint: string): Promise<void> {
  if (!isSafeServerKey(serverName)) {
    throw new Error(`Invalid MCP server name: ${serverName}`);
  }

  const manager = getSettingsManager();
  const userSettings = manager.loadUserSettings();
  const trusted = Object.assign(Object.create(null), userSettings.trustedMcpServers || {}) as Record<string, string>;
  trusted[serverName] = fingerprint;
  await manager.updateUserSetting('trustedMcpServers', trusted);
}

export async function removeTrustedMCPServerFingerprint(serverName: string): Promise<void> {
  if (!isSafeServerKey(serverName)) {
    return;
  }

  const manager = getSettingsManager();
  const userSettings = manager.loadUserSettings();
  const trusted = Object.assign(Object.create(null), userSettings.trustedMcpServers || {}) as Record<string, string>;
  delete trusted[serverName];
  await manager.updateUserSetting('trustedMcpServers', trusted);
}

export const PREDEFINED_SERVERS: Record<string, MCPServerConfig> = {};
