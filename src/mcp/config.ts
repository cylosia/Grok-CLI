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
      command: typeof transport.command === "string" ? transport.command : undefined,
      args: isStringArray(transport.args) ? transport.args : undefined,
      url: typeof transport.url === "string" ? transport.url : undefined,
      env: isRecord(transport.env) ? Object.fromEntries(Object.entries(transport.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined,
      headers: isRecord(transport.headers) ? Object.fromEntries(Object.entries(transport.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined,
    },
    command: typeof command === "string" ? command : undefined,
    args: isStringArray(args) ? args : undefined,
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

export const PREDEFINED_SERVERS: Record<string, MCPServerConfig> = {};
