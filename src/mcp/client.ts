import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTransport, MCPTransport, TransportType } from "./transports.js";
import { getTrustedMCPServerFingerprints, loadMCPConfig } from "./config.js";
import { createHash } from "crypto";
import { logger } from "../utils/logger.js";
import { MCPServerName, parseMCPServerName } from "../types/index.js";

export interface MCPServerConfig {
  name: string;
  transport: {
    type: TransportType;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  command?: string;
  args?: string[];
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

interface ConnectedServer {
  config: MCPServerConfig;
  transport: MCPTransport;
  client: Client;
  tools: MCPTool[];
}

export class MCPManager {
  private servers = new Map<MCPServerName, ConnectedServer>();
  private initialized = false;
  private failedInitializationCooldownUntil = new Map<MCPServerName, number>();
  private static readonly TOOL_CALL_TIMEOUT_MS = 30_000;
  private static readonly INIT_FAILURE_COOLDOWN_MS = 60_000;

  private getServerFingerprint(config: MCPServerConfig): string {
    const payload = {
      name: config.name,
      transport: config.transport,
      command: config.command,
      args: config.args,
    };
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private ensureTrustedServer(config: MCPServerConfig): void {
    const trusted = getTrustedMCPServerFingerprints();
    const expected = trusted[config.name];
    const fingerprint = this.getServerFingerprint(config);
    if (!expected || expected !== fingerprint) {
      throw new Error(
        `Untrusted MCP server configuration for "${config.name}". Re-add via 'grok mcp add ${config.name} ...' to trust this command.`
      );
    }
  }

  async addServer(config: MCPServerConfig): Promise<void> {
    const serverName = parseMCPServerName(config.name);
    if (!serverName) {
      throw new Error(`Invalid MCP server name: ${config.name}`);
    }
    if (this.servers.has(serverName)) {
      return;
    }

    this.ensureTrustedServer(config);

    const transport = createTransport(config.transport);
    const client = new Client(
      { name: "grok-cli", version: "2.0.0" },
      { capabilities: {} }
    );

    try {
      const sdkTransport = await transport.connect();
      await client.connect(sdkTransport);

      const listed = await client.listTools();
      const tools: MCPTool[] = listed.tools.map((tool) => ({
        name: `mcp__${config.name}__${tool.name}`,
        description: tool.description || "MCP tool",
        inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) || {
          type: "object",
          properties: {},
        },
        serverName: config.name,
      }));

      this.servers.set(serverName, {
        config,
        transport,
        client,
        tools,
      });
    } catch (error) {
      await Promise.allSettled([client.close(), transport.disconnect()]);
      throw error;
    }
  }

  async removeServer(name: string): Promise<void> {
    const brandedName = parseMCPServerName(name);
    if (!brandedName) {
      return;
    }
    const server = this.servers.get(brandedName);
    if (!server) {
      return;
    }

    await server.client.close();
    await server.transport.disconnect();
    this.servers.delete(brandedName);
  }

  getTools(): MCPTool[] {
    return [...this.servers.values()].flatMap((server) => server.tools);
  }

  getServers(): string[] {
    return [...this.servers.keys()].map((name) => String(name));
  }

  getTransportType(name: string): string | undefined {
    const brandedName = parseMCPServerName(name);
    if (!brandedName) {
      return undefined;
    }
    return this.servers.get(brandedName)?.transport.getType();
  }

  async ensureServersInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const config = loadMCPConfig();
    const now = Date.now();
    let hadFailures = false;
    for (const server of config.servers) {
      const serverName = parseMCPServerName(server.name);
      if (!serverName) {
        hadFailures = true;
        logger.warn("mcp-server-invalid-name", {
          component: "mcp-client",
          server: server.name,
        });
        continue;
      }
      const cooldownUntil = this.failedInitializationCooldownUntil.get(serverName) ?? 0;
      if (cooldownUntil > now || this.servers.has(serverName)) {
        continue;
      }

      try {
        await this.addServer(server);
        this.failedInitializationCooldownUntil.delete(serverName);
      } catch (error) {
        hadFailures = true;
        this.failedInitializationCooldownUntil.set(serverName, now + MCPManager.INIT_FAILURE_COOLDOWN_MS);
        logger.warn("mcp-server-initialize-failed", {
          component: "mcp-client",
          server: server.name,
          cooldownMs: MCPManager.INIT_FAILURE_COOLDOWN_MS,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.initialized = !hadFailures;
  }

  private async teardownServer(name: MCPServerName): Promise<void> {
    const connected = this.servers.get(name);
    if (!connected) {
      return;
    }

    await Promise.allSettled([
      connected.client.close(),
      connected.transport.disconnect(),
    ]);
    this.servers.delete(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }> {
    const parts = name.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") {
      throw new Error(`Invalid MCP tool name: ${name}`);
    }

    const serverName = parseMCPServerName(parts[1]);
    if (!serverName) {
      throw new Error(`Invalid MCP server name: ${parts[1]}`);
    }
    const toolName = parts.slice(2).join("__");
    const server = this.servers.get(serverName);

    if (!server) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    let timeoutTriggered = false;
    let teardownPromise: Promise<void> | null = null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timeoutTriggered = true;
          teardownPromise = this.teardownServer(serverName);
          void teardownPromise.finally(() => {
            reject(new Error(`MCP tool call timed out after ${MCPManager.TOOL_CALL_TIMEOUT_MS}ms: ${name}`));
          });
        }, MCPManager.TOOL_CALL_TIMEOUT_MS);
      });

      const callPromise = server.client.callTool({
        name: toolName,
        arguments: args,
      });

      const result = await Promise.race([callPromise, timeoutPromise]);

      return {
        content: Array.isArray(result.content) ? result.content : [],
      };
    } catch (error) {
      if (timeoutTriggered && teardownPromise) {
        await teardownPromise;
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
