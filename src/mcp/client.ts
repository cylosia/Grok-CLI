export interface MCPServerConfig {
  name: string;
  transport: {
    type: 'stdio' | 'http' | 'sse' | 'streamable_http';
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
  inputSchema: any;
  serverName: string;
}

export class MCPManager {
  async addServer(config: MCPServerConfig): Promise<void> {}
  async removeServer(name: string): Promise<void> {}
  getTools(): MCPTool[] { return []; }
  getServers(): string[] { return []; }
  getTransportType(name: string): string | undefined { return undefined; }
  ensureServersInitialized(): Promise<void> { return Promise.resolve(); }
  async callTool(name: string, args: any): Promise<any> { return { content: [] }; }
}
