import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTransport, MCPTransport, TransportType } from "./transports.js";
import { getTrustedMCPServerFingerprints, loadMCPConfig } from "./config.js";
import { createHash } from "crypto";
import { logger } from "../utils/logger.js";
import { MCPServerName, parseMCPServerName } from "../types/index.js";
import { canonicalJsonStringify } from "../utils/canonical-json.js";

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
  private static readonly TEARDOWN_TIMEOUT_MS = 5_000;
  private static readonly TIMED_OUT_CALL_COOLDOWN_MS = 30_000;
  private timedOutCallCooldownUntil = new Map<string, number>();
  private inFlightToolCalls = new Map<string, Promise<{ content: unknown[] }>>();

  private getServerFingerprint(config: MCPServerConfig): string {
    const payload = {
      name: config.name,
      transport: config.transport,
      command: config.command,
      args: config.args,
    };
    return createHash("sha256").update(canonicalJsonStringify(payload)).digest("hex");
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

  private async teardownServerWithTimeout(name: MCPServerName): Promise<void> {
    await Promise.race([
      this.teardownServer(name),
      new Promise<void>((resolve) => {
        setTimeout(resolve, MCPManager.TEARDOWN_TIMEOUT_MS);
      }),
    ]);
  }

  private buildCallKey(name: string, args: Record<string, unknown>): string {
    return createHash("sha256").update(canonicalJsonStringify({ name, args })).digest("hex");
  }

  private async awaitInFlightCall(name: string, callPromise: Promise<{ content: unknown[] }>): Promise<{ content: unknown[] }> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`MCP tool call timed out while waiting for in-flight result: ${name}`));
        }, MCPManager.TOOL_CALL_TIMEOUT_MS);
      });
      return await Promise.race([callPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private assertCallNotCoolingDown(callKey: string, name: string): void {
    const until = this.timedOutCallCooldownUntil.get(callKey) ?? 0;
    const now = Date.now();
    if (until > now) {
      throw new Error(`MCP tool call is cooling down after a timeout: ${name}`);
    }
    if (until !== 0) {
      this.timedOutCallCooldownUntil.delete(callKey);
    }
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
    const callKey = this.buildCallKey(name, args);
    const existingCall = this.inFlightToolCalls.get(callKey);
    if (existingCall) {
      return this.awaitInFlightCall(name, existingCall);
    }
    this.assertCallNotCoolingDown(callKey, name);
    const server = this.servers.get(serverName);

    if (!server) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const controller = new AbortController();

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const timeoutError = new Error(`MCP tool call timed out after ${MCPManager.TOOL_CALL_TIMEOUT_MS}ms: ${name}`);
          this.timedOutCallCooldownUntil.set(callKey, Date.now() + MCPManager.TIMED_OUT_CALL_COOLDOWN_MS);
          controller.abort(timeoutError);
          void this.teardownServerWithTimeout(serverName).then(() => {
            reject(timeoutError);
          }).catch((teardownError) => {
            logger.warn("mcp-server-teardown-after-timeout-failed", {
              component: "mcp-client",
              server: String(serverName),
              error: teardownError instanceof Error ? teardownError.message : String(teardownError),
            });
            reject(timeoutError);
          });
        }, MCPManager.TOOL_CALL_TIMEOUT_MS);
      });

      const callPromise = server.client.callTool({
        name: toolName,
        arguments: args,
      }, undefined, {
        signal: controller.signal,
        timeout: MCPManager.TOOL_CALL_TIMEOUT_MS,
      });

      const normalizedCallPromise = callPromise
        .then((result) => ({
          content: Array.isArray(result.content) ? result.content : [],
        }))
        .finally(() => {
          this.inFlightToolCalls.delete(callKey);
        });
      this.inFlightToolCalls.set(callKey, normalizedCallPromise);

      return await Promise.race([normalizedCallPromise, timeoutPromise]);
    } catch (error) {
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
