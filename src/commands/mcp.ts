import { Command } from 'commander';
import { addMCPServer, removeMCPServer, loadMCPConfig, PREDEFINED_SERVERS, removeTrustedMCPServerFingerprint, setTrustedMCPServerFingerprint } from '../mcp/config.js';
import { getMCPManager } from '../grok/tools.js';
import { MCPServerConfig } from '../mcp/client.js';
import chalk from 'chalk';
import { createHash } from 'crypto';
import { canonicalJsonStringify } from '../utils/canonical-json.js';


const MAX_JSON_CONFIG_LENGTH = 64 * 1024;
const MAX_JSON_CONFIG_DEPTH = 20;

function getJsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_JSON_CONFIG_DEPTH) {
    return depth;
  }
  if (!value || typeof value !== 'object') {
    return depth;
  }
  if (Array.isArray(value)) {
    return value.reduce((maxDepth, entry) => Math.max(maxDepth, getJsonDepth(entry, depth + 1)), depth);
  }
  return Object.values(value).reduce((maxDepth, entry) => Math.max(maxDepth, getJsonDepth(entry, depth + 1)), depth);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseTransportType(value: unknown): 'stdio' | 'http' | 'sse' {
  if (value === 'stdio' || value === 'http' || value === 'sse') {
    return value;
  }
  throw new Error(`Invalid transport type: ${String(value)}`);
}

function parseJsonServerConfig(raw: unknown): MCPServerConfig['transport'] {
  if (!isRecord(raw)) {
    throw new Error('JSON config must be an object');
  }

  const transportRaw = isRecord(raw.transport) ? raw.transport : raw;
  if (typeof transportRaw.type !== 'string') {
    throw new Error('transport.type is required and must be a string');
  }
  const type = parseTransportType(transportRaw.type);
  const transport: MCPServerConfig['transport'] = { type };

  if (type === 'stdio') {
    const command = transportRaw.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('stdio transport requires a non-empty command');
    }
    transport.command = command;
    if (isStringArray(transportRaw.args)) {
      transport.args = transportRaw.args;
    }
    if (isStringRecord(transportRaw.env)) {
      transport.env = transportRaw.env;
    }
    return transport;
  }

  throw new Error(`${type} transport is temporarily disabled until full duplex MCP support is implemented`);
}

function getServerFingerprint(config: MCPServerConfig): string {
  return createHash('sha256').update(canonicalJsonStringify({
    name: config.name,
    transport: config.transport,
    command: config.command,
    args: config.args,
  })).digest('hex');
}

export function createMCPCommand(): Command {
  const mcpCommand = new Command('mcp');
  mcpCommand.description('Manage MCP (Model Context Protocol) servers');

  // Add server command
  mcpCommand
    .command('add <name>')
    .description('Add an MCP server')
    .option('-t, --transport <type>', 'Transport type (stdio, http, sse)', 'stdio')
    .option('-c, --command <command>', 'Command to run the server (for stdio transport)')
    .option('-a, --args [args...]', 'Arguments for the server command (for stdio transport)', [])
    .option('-u, --url <url>', 'URL for HTTP/SSE transport')
    .option('-h, --headers [headers...]', 'HTTP headers (key=value format)', [])
    .option('-e, --env [env...]', 'Environment variables (key=value format)', [])
    .action(async (name: string, options) => {
      try {
        // Check if it's a predefined server
        if (PREDEFINED_SERVERS[name]) {
          const config = PREDEFINED_SERVERS[name];
          const manager = getMCPManager();
          await manager.addServer(config);

          await addMCPServer(config);
          await setTrustedMCPServerFingerprint(name, getServerFingerprint(config));
          console.log(chalk.green(`✓ Added predefined MCP server: ${name}`));
          console.log(chalk.green(`✓ Connected to MCP server: ${name}`));
          
          const tools = manager.getTools().filter(t => t.serverName === name);
          console.log(chalk.blue(`  Available tools: ${tools.length}`));
          
          return;
        }

        // Custom server
        const transportType = parseTransportType(String(options.transport).toLowerCase());
        
        if (transportType === 'stdio') {
          if (!options.command) {
            console.error(chalk.red('Error: --command is required for stdio transport'));
            throw new Error('--command is required for stdio transport');
          }
        } else if (transportType === 'http' || transportType === 'sse') {
          console.error(chalk.red(`Error: ${transportType} transport is temporarily disabled until full duplex MCP support is implemented`));
          throw new Error(`${transportType} transport is temporarily disabled until full duplex MCP support is implemented`);
        } else {
          console.error(chalk.red('Error: Transport type must be stdio, http, or sse'));
          throw new Error('Transport type must be stdio, http, or sse');
        }

        // Parse environment variables
        const env: Record<string, string> = {};
        for (const envVar of options.env || []) {
          const [key, value] = envVar.split('=', 2);
          if (key && value) {
            env[key] = value;
          }
        }

        // Parse headers
        const headers: Record<string, string> = {};
        for (const header of options.headers || []) {
          const [key, value] = header.split('=', 2);
          if (key && value) {
            headers[key] = value;
          }
        }

        const transport: MCPServerConfig['transport'] = {
          type: transportType,
          ...(typeof options.command === 'string' ? { command: options.command } : {}),
          ...(Array.isArray(options.args) ? { args: options.args } : {}),
          ...(typeof options.url === 'string' ? { url: options.url } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        };

        const config: MCPServerConfig = {
          name,
          transport,
        };

        const manager = getMCPManager();
        await manager.addServer(config);

        await addMCPServer(config);
        await setTrustedMCPServerFingerprint(name, getServerFingerprint(config));
        console.log(chalk.green(`✓ Added MCP server: ${name}`));
        console.log(chalk.green(`✓ Connected to MCP server: ${name}`));
        
        const tools = manager.getTools().filter(t => t.serverName === name);
        console.log(chalk.blue(`  Available tools: ${tools.length}`));

      } catch (error: unknown) {
        console.error(chalk.red(`Error adding MCP server: ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
      }
    });

  // Add server from JSON command
  mcpCommand
    .command('add-json <name> <json>')
    .description('Add an MCP server from JSON configuration')
    .action(async (name: string, jsonConfig: string) => {
      try {
        if (jsonConfig.length > MAX_JSON_CONFIG_LENGTH) {
          throw new Error(`JSON configuration is too large (max ${MAX_JSON_CONFIG_LENGTH} bytes)`);
        }

        let config: unknown;
        try {
          config = JSON.parse(jsonConfig);
        } catch (_error) {
          console.error(chalk.red('Error: Invalid JSON configuration'));
          throw new Error('Invalid JSON configuration');
        }

        if (getJsonDepth(config) > MAX_JSON_CONFIG_DEPTH) {
          throw new Error(`JSON configuration exceeds max depth of ${MAX_JSON_CONFIG_DEPTH}`);
        }

        const transportConfig = parseJsonServerConfig(config);

        const serverConfig: MCPServerConfig = {
          name,
          transport: transportConfig,
        };

        const manager = getMCPManager();
        await manager.addServer(serverConfig);

        await addMCPServer(serverConfig);
        await setTrustedMCPServerFingerprint(name, getServerFingerprint(serverConfig));
        console.log(chalk.green(`✓ Added MCP server: ${name}`));
        console.log(chalk.green(`✓ Connected to MCP server: ${name}`));
        
        const tools = manager.getTools().filter(t => t.serverName === name);
        console.log(chalk.blue(`  Available tools: ${tools.length}`));

      } catch (error: unknown) {
        console.error(chalk.red(`Error adding MCP server: ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
      }
    });

  // Remove server command
  mcpCommand
    .command('remove <name>')
    .description('Remove an MCP server')
    .action(async (name: string) => {
      try {
        const manager = getMCPManager();
        await manager.removeServer(name);
        await removeMCPServer(name);
        await removeTrustedMCPServerFingerprint(name);
        console.log(chalk.green(`✓ Removed MCP server: ${name}`));
      } catch (error: unknown) {
        console.error(chalk.red(`Error removing MCP server: ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
      }
    });

  // List servers command
  mcpCommand
    .command('list')
    .description('List configured MCP servers')
    .action(() => {
      const config = loadMCPConfig();
      const manager = getMCPManager();
      
      if (config.servers.length === 0) {
        console.log(chalk.yellow('No MCP servers configured'));
        return;
      }

      console.log(chalk.bold('Configured MCP servers:'));
      console.log();

      for (const server of config.servers) {
        const isConnected = manager.getServers().includes(server.name);
        const status = isConnected 
          ? chalk.green('✓ Connected') 
          : chalk.red('✗ Disconnected');
        
        console.log(`${chalk.bold(server.name)}: ${status}`);
        
        // Display transport information
        if (server.transport) {
          console.log(`  Transport: ${server.transport.type}`);
          if (server.transport.type === 'stdio') {
            console.log(`  Command: ${server.transport.command} ${(server.transport.args || []).join(' ')}`);
          } else if (server.transport.type === 'http' || server.transport.type === 'sse') {
            console.log(`  URL: ${server.transport.url}`);
          }
        } else if (server.command) {
          // Legacy format
          console.log(`  Command: ${server.command} ${(server.args || []).join(' ')}`);
        }
        
        if (isConnected) {
          const transportType = manager.getTransportType(server.name);
          if (transportType) {
            console.log(`  Active Transport: ${transportType}`);
          }
          
          const tools = manager.getTools().filter(t => t.serverName === server.name);
          console.log(`  Tools: ${tools.length}`);
          if (tools.length > 0) {
            tools.forEach(tool => {
              const displayName = tool.name.replace(`mcp__${server.name}__`, '');
              console.log(`    - ${displayName}: ${tool.description}`);
            });
          }
        }
        
        console.log();
      }
    });

  // Test server command
  mcpCommand
    .command('test <name>')
    .description('Test connection to an MCP server')
    .action(async (name: string) => {
      try {
        const config = loadMCPConfig();
        const serverConfig = config.servers.find(s => s.name === name);
        
        if (!serverConfig) {
          console.error(chalk.red(`Server ${name} not found`));
          throw new Error(`Server ${name} not found`);
        }

        console.log(chalk.blue(`Testing connection to ${name}...`));
        
        const manager = getMCPManager();
        await manager.addServer(serverConfig);
        
        const tools = manager.getTools().filter(t => t.serverName === name);
        console.log(chalk.green(`✓ Successfully connected to ${name}`));
        console.log(chalk.blue(`  Available tools: ${tools.length}`));
        
        if (tools.length > 0) {
          console.log('  Tools:');
          tools.forEach(tool => {
            const displayName = tool.name.replace(`mcp__${name}__`, '');
            console.log(`    - ${displayName}: ${tool.description}`);
          });
        }

      } catch (error: unknown) {
        console.error(chalk.red(`✗ Failed to connect to ${name}: ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
      }
    });

  return mcpCommand;
}
