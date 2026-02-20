import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import axios, { AxiosInstance } from "axios";

export type TransportType = 'stdio' | 'http' | 'sse';

export interface TransportConfig {
  type: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPTransport {
  connect(): Promise<Transport>;
  disconnect(): Promise<void>;
  getType(): TransportType;
}

export class StdioTransport implements MCPTransport {
  private transport: StdioClientTransport | null = null;
  private process: ChildProcess | null = null;

  constructor(private config: TransportConfig) {
    if (!config.command) {
      throw new Error('Command is required for stdio transport');
    }
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
    const env = {
      ...baseEnv,
      ...this.config.env,
      // Try to suppress verbose output from mcp-remote
      MCP_REMOTE_QUIET: '1',
      MCP_REMOTE_SILENT: '1',
      DEBUG: '',
      NODE_ENV: 'production'
    };

    this.transport = new StdioClientTransport({
      command: this.config.command!,
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

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  getType(): TransportType {
    return 'stdio';
  }
}

export class HttpTransport extends EventEmitter implements MCPTransport {

  constructor(private config: TransportConfig) {
    super();
    if (!config.url) {
      throw new Error('URL is required for HTTP transport');
    }
  }

  async connect(): Promise<Transport> {
    const client = axios.create({
      ...(this.config.url ? { baseURL: this.config.url } : {}),
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers
      }
    });

    // Test connection
    try {
      await client.get('/health');
    } catch (error) {
      this.emit('transport-warning', {
        type: 'http-health-check-failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return new HttpClientTransport(client);
  }

  async disconnect(): Promise<void> {
  }

  getType(): TransportType {
    return 'http';
  }
}

export class SSETransport extends EventEmitter implements MCPTransport {

  constructor(private config: TransportConfig) {
    super();
    if (!config.url) {
      throw new Error('URL is required for SSE transport');
    }
  }

  async connect(): Promise<Transport> {
    return new Promise((resolve, reject) => {
      try {
        // For Node.js environment, we'll use a simple HTTP-based approach
        // In a real implementation, you'd use a proper SSE library like 'eventsource'
          resolve(new SSEClientTransport(this.config.url!));
      } catch (error) {
        reject(error);
      }
    });
  }

  async disconnect(): Promise<void> {
  }

  getType(): TransportType {
    return 'sse';
  }
}

// Custom HTTP Transport implementation
class HttpClientTransport extends EventEmitter implements Transport {
  constructor(private client: AxiosInstance) {
    super();
  }

  async start(): Promise<void> {
    // HTTP transport is connection-less, so we're always "started"
  }

  async close(): Promise<void> {
    // Nothing to close for HTTP transport
  }

  async send(message: Parameters<Transport["send"]>[0]): Promise<void> {
    try {
      await this.client.post('/rpc', message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`HTTP transport error: ${reason}`);
    }
  }
}

// Custom SSE Transport implementation
class SSEClientTransport extends EventEmitter implements Transport {
  constructor(private url: string) {
    super();
  }

  async start(): Promise<void> {
    // SSE transport is event-driven, so we're always "started"
  }

  async close(): Promise<void> {
    // Nothing to close for basic SSE transport
  }

  async send(message: Parameters<Transport["send"]>[0]): Promise<void> {
    // For bidirectional communication over SSE, we typically use HTTP POST
    // for sending messages and SSE for receiving
    try {
      await axios.post(this.url.replace('/sse', '/rpc'), message, {
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`SSE transport error: ${reason}`);
    }
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
