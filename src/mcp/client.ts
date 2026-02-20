import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTransport, MCPTransport, TransportType } from "./transports.js";
import { getTrustedMCPServerFingerprints, loadMCPConfig } from "./config.js";
import { createHash } from "crypto";

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
  private servers = new Map<string, ConnectedServer>();
  private initialized = false;

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
    if (config.transport.type !== "stdio") {
      return;
    }

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
    if (this.servers.has(config.name)) {
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

      this.servers.set(config.name, {
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
    const server = this.servers.get(name);
    if (!server) {
      return;
    }

    await server.client.close();
    await server.transport.disconnect();
    this.servers.delete(name);
  }

  getTools(): MCPTool[] {
    return [...this.servers.values()].flatMap((server) => server.tools);
  }

  getServers(): string[] {
    return [...this.servers.keys()];
  }

  getTransportType(name: string): string | undefined {
    return this.servers.get(name)?.transport.getType();
  }

  async ensureServersInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    let successfulInitializations = 0;
    const config = loadMCPConfig();
    for (const server of config.servers) {
      try {
        await this.addServer(server);
        successfulInitializations += 1;
      } catch (error) {
        console.warn(`Failed to initialize MCP server "${server.name}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.initialized = successfulInitializations === config.servers.length;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }> {
    const parts = name.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") {
      throw new Error(`Invalid MCP tool name: ${name}`);
    }

    const serverName = parts[1];
    const toolName = parts.slice(2).join("__");
    const server = this.servers.get(serverName);

    if (!server) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    const result = await server.client.callTool({
      name: toolName,
      arguments: args,
    });

    return {
      content: Array.isArray(result.content) ? result.content : [],
    };
  }
}
