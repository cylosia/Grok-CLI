import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventEmitter } from "events";
import { validateMcpUrl } from "./url-policy.js";

export type TransportType = 'stdio' | 'http' | 'sse';

export interface TransportConfig {
  type: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const PROTECTED_ENV_KEYS = new Set(["PATH", "HOME", "NODE_OPTIONS"]);
const MCP_ENV_ALLOWLIST = new Set([
  "MCP_TOOL_TIMEOUT_MS",
  "MCP_CHILD_KILL_GRACE_MS",
  "MCP_MAX_OUTPUT_BYTES",
  "MCP_REMOTE_QUIET",
  "MCP_REMOTE_SILENT",
]);

function isAllowedMcpEnvKey(key: string): boolean {
  return MCP_ENV_ALLOWLIST.has(key);
}
const DEFAULT_MCP_TOOL_TIMEOUT_MS = "30000";
const DEFAULT_MCP_CHILD_KILL_GRACE_MS = "1500";
const DEFAULT_MCP_MAX_OUTPUT_BYTES = "1000000";

export interface MCPTransport {
  connect(): Promise<Transport>;
  disconnect(): Promise<void>;
  getType(): TransportType;
}

export class StdioTransport implements MCPTransport {
  private transport: StdioClientTransport | null = null;
  private readonly command: string;

  constructor(private config: TransportConfig) {
    if (!config.command) {
      throw new Error('Command is required for stdio transport');
    }
    this.command = config.command;
  }

  async connect(): Promise<Transport> {
    const allowlistedEnvKeys = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL"];
    const baseEnv = allowlistedEnvKeys.reduce<Record<string, string>>((acc, key) => {
      const value = process.env[key];
      if (typeof value === "string") {
        acc[key] = value;
      }
      return acc;
    }, {});

    // Create transport with sanitized environment variables to suppress verbose output
    const overrides = this.config.env || {};
    const rejectedKeys = Object.keys(overrides).filter(
      (key) => PROTECTED_ENV_KEYS.has(key) || !isAllowedMcpEnvKey(key)
    );
    if (rejectedKeys.length > 0) {
      throw new Error(`Unsupported MCP stdio env override keys: ${rejectedKeys.join(", ")}`);
    }

    const sanitizedOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([key]) => isAllowedMcpEnvKey(key))
    );

    const env = {
      ...baseEnv,
      ...sanitizedOverrides,
      MCP_TOOL_TIMEOUT_MS: process.env.MCP_TOOL_TIMEOUT_MS || DEFAULT_MCP_TOOL_TIMEOUT_MS,
      MCP_CHILD_KILL_GRACE_MS: process.env.MCP_CHILD_KILL_GRACE_MS || DEFAULT_MCP_CHILD_KILL_GRACE_MS,
      MCP_MAX_OUTPUT_BYTES: process.env.MCP_MAX_OUTPUT_BYTES || DEFAULT_MCP_MAX_OUTPUT_BYTES,
      // Try to suppress verbose output from mcp-remote
      MCP_REMOTE_QUIET: '1',
      MCP_REMOTE_SILENT: '1',
      DEBUG: '',
      NODE_ENV: 'production'
    };

    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.config.args || [],
      env
    });

    return this.transport;
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }

  }

  getType(): TransportType {
    return 'stdio';
  }
}

export class HttpTransport extends EventEmitter implements MCPTransport {
  private readonly url: string;

  constructor(config: TransportConfig) {
    super();
    if (!config.url) {
      throw new Error('URL is required for HTTP transport');
    }
    this.url = config.url;
  }

  async connect(): Promise<Transport> {
    await validateMcpUrl(this.url, {
      allowLocalHttp: process.env.GROK_ALLOW_LOCAL_MCP_HTTP === "1",
      allowPrivateHttps: process.env.GROK_ALLOW_PRIVATE_MCP_HTTPS === "1",
    });
    throw new Error("HTTP MCP transport is temporarily disabled until full duplex SDK transport support is implemented");
  }

  async disconnect(): Promise<void> {
    // No-op while transport is disabled.
  }

  getType(): TransportType {
    return 'http';
  }
}

export class SSETransport extends EventEmitter implements MCPTransport {
  private readonly url: string;

  constructor(config: TransportConfig) {
    super();
    if (!config.url) {
      throw new Error('URL is required for SSE transport');
    }
    this.url = config.url;
  }

  async connect(): Promise<Transport> {
    await validateMcpUrl(this.url, {
      allowLocalHttp: process.env.GROK_ALLOW_LOCAL_MCP_HTTP === "1",
      allowPrivateHttps: process.env.GROK_ALLOW_PRIVATE_MCP_HTTPS === "1",
    });
    throw new Error("SSE MCP transport is temporarily disabled until full duplex SDK transport support is implemented");
  }

  async disconnect(): Promise<void> {
    // No-op while transport is disabled.
  }

  getType(): TransportType {
    return 'sse';
  }
}

export function createTransport(config: TransportConfig): MCPTransport {
  switch (config.type) {
    case 'stdio':
      return new StdioTransport(config);
    case 'http':
      return new HttpTransport(config);
    case 'sse':
      return new SSETransport(config);
    default:
      throw new Error(`Unsupported transport type: ${config.type}`);
  }
}
