import { getSettingsManager } from "../utils/settings-manager.js";
import { MCPServerConfig } from "./client.js";

export interface MCPConfig {
  servers: MCPServerConfig[];
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
  const rawServers = projectSettings.mcpServers ? Object.values(projectSettings.mcpServers) : [];
  const servers = rawServers
    .map((server) => parseMCPServerConfig(server))
    .filter((server): server is MCPServerConfig => server !== null);

  return { servers };
}

export function addMCPServer(config: MCPServerConfig): void {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const mcpServers = projectSettings.mcpServers || {};
  mcpServers[config.name] = config;
  manager.updateProjectSetting('mcpServers', mcpServers);
}

export function removeMCPServer(serverName: string): void {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const mcpServers = projectSettings.mcpServers || {};
  delete mcpServers[serverName];
  manager.updateProjectSetting('mcpServers', mcpServers);
}

export function getTrustedMCPServerFingerprints(): Record<string, string> {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  return projectSettings.trustedMcpServers || {};
}

export function setTrustedMCPServerFingerprint(serverName: string, fingerprint: string): void {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const trusted = projectSettings.trustedMcpServers || {};
  trusted[serverName] = fingerprint;
  manager.updateProjectSetting('trustedMcpServers', trusted);
}

export function removeTrustedMCPServerFingerprint(serverName: string): void {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const trusted = projectSettings.trustedMcpServers || {};
  delete trusted[serverName];
  manager.updateProjectSetting('trustedMcpServers', trusted);
}

export const PREDEFINED_SERVERS: Record<string, MCPServerConfig> = {};
