import { Command } from 'commander';
import { addMCPServer, removeMCPServer, loadMCPConfig, PREDEFINED_SERVERS, removeTrustedMCPServerFingerprint, setTrustedMCPServerFingerprint } from '../mcp/config.js';
import { getMCPManager } from '../grok/tools.js';
import { MCPServerConfig } from '../mcp/client.js';
import chalk from 'chalk';
import { createHash } from 'crypto';
import { canonicalJsonStringify } from '../utils/canonical-json.js';
import { sanitizeTerminalText } from '../utils/terminal-sanitize.js';
import { logger } from '../utils/logger.js';


const MAX_JSON_CONFIG_LENGTH = 64 * 1024;
const MAX_JSON_CONFIG_DEPTH = 20;


const CLI_SECRET_ARG_KEY_PATTERN = /(token|api[-_]?key|secret|password|authorization|cookie)/i;
const CLI_SECRET_ARG_VALUE_PATTERN = /^(?:bearer\s+)?[A-Za-z0-9_\-]{20,}$/i;

export function redactCliArg(arg: string): string {
  const [key = "", ...rest] = arg.split("=");
  if (rest.length > 0) {
    const value = rest.join("=");
    if (CLI_SECRET_ARG_KEY_PATTERN.test(key) || CLI_SECRET_ARG_VALUE_PATTERN.test(value)) {
      return `${key}=[REDACTED]`;
    }
    return arg;
  }

  if (CLI_SECRET_ARG_VALUE_PATTERN.test(arg)) {
    return "[REDACTED]";
  }

  return arg;
}

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

function logMcpCommandError(action: string, error: unknown, extras: Record<string, unknown> = {}): void {
  logger.error("mcp-command-failed", {
    component: "commands-mcp",
    action,
    error: error instanceof Error ? error.message : String(error),
    ...extras,
  });
}

async function addServerAtomically(name: string, config: MCPServerConfig): Promise<void> {
  const manager = getMCPManager();
  await manager.addServer(config);

  let persistedConfig = false;
  try {
    await addMCPServer(config);
    persistedConfig = true;
    await setTrustedMCPServerFingerprint(name, getServerFingerprint(config));
  } catch (error) {
    if (persistedConfig) {
      await removeMCPServer(name).catch(() => undefined);
    }
    await manager.removeServer(name);
    throw error;
  }
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
          await addServerAtomically(name, config);
          const manager = getMCPManager();
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

        await addServerAtomically(name, config);
        const manager = getMCPManager();
        console.log(chalk.green(`✓ Added MCP server: ${name}`));
        console.log(chalk.green(`✓ Connected to MCP server: ${name}`));
        
        const tools = manager.getTools().filter(t => t.serverName === name);
        console.log(chalk.blue(`  Available tools: ${tools.length}`));

      } catch (error: unknown) {
        logMcpCommandError('add', error, { server: name });
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

        await addServerAtomically(name, serverConfig);
        const manager = getMCPManager();
        console.log(chalk.green(`✓ Added MCP server: ${name}`));
        console.log(chalk.green(`✓ Connected to MCP server: ${name}`));
        
        const tools = manager.getTools().filter(t => t.serverName === name);
        console.log(chalk.blue(`  Available tools: ${tools.length}`));

      } catch (error: unknown) {
        logMcpCommandError('add', error, { server: name });
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
        logMcpCommandError('remove', error, { server: name });
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
        
        console.log(`${chalk.bold(sanitizeTerminalText(server.name))}: ${status}`);
        
        // Display transport information
        if (server.transport) {
          console.log(`  Transport: ${server.transport.type}`);
          if (server.transport.type === 'stdio') {
            const redactedArgs = (server.transport.args || []).map((arg) => sanitizeTerminalText(redactCliArg(arg)));
            const safeCommand = sanitizeTerminalText(String(server.transport.command || ""));
            console.log(`  Command: ${safeCommand} ${redactedArgs.join(' ')}`.trimEnd());
          } else if (server.transport.type === 'http' || server.transport.type === 'sse') {
            console.log(`  URL: ${sanitizeTerminalText(String(server.transport.url || ''))}`);
          }
        } else if (server.command) {
          // Legacy format
          console.log(`  Command: ${sanitizeTerminalText(server.command)} ${(server.args || []).map((arg) => sanitizeTerminalText(redactCliArg(arg))).join(' ')}`);
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
              const displayName = sanitizeTerminalText(tool.name.replace(`mcp__${server.name}__`, ''));
              const safeDescription = sanitizeTerminalText(tool.description);
              console.log(`    - ${displayName}: ${safeDescription}`);
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

        try {
          const tools = manager.getTools().filter(t => t.serverName === name);
          console.log(chalk.green(`✓ Successfully connected to ${name}`));
          console.log(chalk.blue(`  Available tools: ${tools.length}`));

          if (tools.length > 0) {
            console.log('  Tools:');
            tools.forEach(tool => {
              const displayName = sanitizeTerminalText(tool.name.replace(`mcp__${name}__`, ''));
              const safeDescription = sanitizeTerminalText(tool.description);
              console.log(`    - ${displayName}: ${safeDescription}`);
            });
          }
        } finally {
          await manager.removeServer(name).catch(() => undefined);
        }

      } catch (error: unknown) {
        logMcpCommandError('test', error, { server: name });
        console.error(chalk.red(`✗ Failed to connect to ${name}: ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
      }
    });

  return mcpCommand;
}
