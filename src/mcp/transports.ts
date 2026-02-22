import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventEmitter } from "events";
import { validateMcpUrl } from "./url-policy.js";
import { killProcessTree } from "../utils/process-tree.js";

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
// Deny-listed prefixes/names for GROK_MCP_PASSTHROUGH_ENV to prevent
// accidental forwarding of sensitive credentials to MCP child processes.
const PASSTHROUGH_DENYLIST_PREFIXES = [
  "AWS_", "AZURE_", "GCP_", "GOOGLE_", "GCLOUD_",
  "DATABASE_", "DB_", "REDIS_", "MONGO",
  "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN",
  "NPM_TOKEN", "NODE_AUTH_TOKEN",
  "GROK_API", "OPENAI_API", "ANTHROPIC_API",
  "SECRET", "PASSWORD", "CREDENTIAL",
  "PRIVATE_KEY", "SSH_",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_",
];
const MCP_ENV_ALLOWLIST = new Set([
  "MCP_TOOL_TIMEOUT_MS",
  "MCP_CHILD_KILL_GRACE_MS",
  "MCP_MAX_OUTPUT_BYTES",
  "MCP_REMOTE_QUIET",
  "MCP_REMOTE_SILENT",
]);
const DEFAULT_PASSTHROUGH_ENV_KEYS = process.platform === "win32"
  ? ["PATH", "SystemRoot", "ComSpec"]
  : ["PATH"];

function isAllowedMcpEnvKey(key: string): boolean {
  return MCP_ENV_ALLOWLIST.has(key);
}

function isDeniedPassthroughKey(key: string): boolean {
  const upper = key.toUpperCase();
  return PASSTHROUGH_DENYLIST_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

function readPassthroughEnv(): Record<string, string> {
  const configured = process.env.GROK_MCP_PASSTHROUGH_ENV ?? "";
  const extraKeys = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Z0-9_]{1,64}$/i.test(entry))
    .filter((entry) => !isDeniedPassthroughKey(entry));

  const allowedKeys = new Set<string>([...DEFAULT_PASSTHROUGH_ENV_KEYS, ...extraKeys]);
  return [...allowedKeys].reduce<Record<string, string>>((acc, key) => {
    const value = process.env[key];
    if (typeof value === "string") {
      acc[key] = value;
    }
    return acc;
  }, {});
}
const DEFAULT_MCP_TOOL_TIMEOUT_MS = "30000";
const DEFAULT_MCP_CHILD_KILL_GRACE_MS = "1500";
const DEFAULT_MCP_MAX_OUTPUT_BYTES = "1000000";

const MCP_ENV_LIMITS = {
  MCP_TOOL_TIMEOUT_MS: { min: 1_000, max: 120_000 },
  MCP_CHILD_KILL_GRACE_MS: { min: 100, max: 10_000 },
  MCP_MAX_OUTPUT_BYTES: { min: 64 * 1024, max: 10 * 1024 * 1024 },
} as const;

function parseBoundedMcpEnvInt(
  key: keyof typeof MCP_ENV_LIMITS,
  rawValue: string
): string {
  const numeric = Number(rawValue);
  const { min, max } = MCP_ENV_LIMITS[key];
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return String(numeric);
}

export interface MCPTransport {
  connect(): Promise<Transport>;
  disconnect(): Promise<void>;
  forceDisconnect(): Promise<void>;
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
    const baseEnv = readPassthroughEnv();

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

    const configuredToolTimeout = parseBoundedMcpEnvInt(
      "MCP_TOOL_TIMEOUT_MS",
      sanitizedOverrides.MCP_TOOL_TIMEOUT_MS
        || process.env.MCP_TOOL_TIMEOUT_MS
        || DEFAULT_MCP_TOOL_TIMEOUT_MS
    );
    const configuredKillGrace = parseBoundedMcpEnvInt(
      "MCP_CHILD_KILL_GRACE_MS",
      sanitizedOverrides.MCP_CHILD_KILL_GRACE_MS
        || process.env.MCP_CHILD_KILL_GRACE_MS
        || DEFAULT_MCP_CHILD_KILL_GRACE_MS
    );
    const configuredMaxOutput = parseBoundedMcpEnvInt(
      "MCP_MAX_OUTPUT_BYTES",
      sanitizedOverrides.MCP_MAX_OUTPUT_BYTES
        || process.env.MCP_MAX_OUTPUT_BYTES
        || DEFAULT_MCP_MAX_OUTPUT_BYTES
    );

    const env = {
      ...baseEnv,
      ...sanitizedOverrides,
      MCP_TOOL_TIMEOUT_MS: configuredToolTimeout,
      MCP_CHILD_KILL_GRACE_MS: configuredKillGrace,
      MCP_MAX_OUTPUT_BYTES: configuredMaxOutput,
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

  private extractTransportPid(candidate: unknown): number | undefined {
    if (!candidate || typeof candidate !== "object") {
      return undefined;
    }
    const processValue = Reflect.get(candidate as object, "process");
    if (!processValue || typeof processValue !== "object") {
      return undefined;
    }
    const pidValue = Reflect.get(processValue as object, "pid");
    return typeof pidValue === "number" ? pidValue : undefined;
  }

  async forceDisconnect(): Promise<void> {
    const pid = this.extractTransportPid(this.transport);
    if (typeof pid === "number") {
      killProcessTree(pid, "SIGKILL");
    }
    await this.disconnect();
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

  async forceDisconnect(): Promise<void> {
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

  async forceDisconnect(): Promise<void> {
    // No-op while transport is disabled.
  }

  getType(): TransportType {
    return 'sse';
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported transport type: ${String(value)}`);
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
      return assertNever(config.type);
  }
}
