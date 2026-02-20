import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ToolResult } from '../types/index.js';
import { ConfirmationService } from '../utils/confirmation-service.js';

const ALLOWED_COMMANDS = new Set([
  'git', 'ls', 'pwd', 'cat', 'mkdir', 'touch', 'echo', 'grep', 'find', 'rg'
]);

const BLOCKED_COMMANDS = new Set(['rm', 'mv', 'cp', 'node', 'npm']);

const UNSAFE_SHELL_METACHARS = /[;&|><`\n\r]/;
const MAX_OUTPUT_BYTES = 1_000_000;

export class BashTool {
  private workspaceRoot: string = process.cwd();
  private currentDirectory: string = process.cwd();
  private canonicalWorkspaceRootPromise: Promise<string>;
  private confirmationService = ConfirmationService.getInstance();

  constructor() {
    this.canonicalWorkspaceRootPromise = fs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot);
  }

  async execute(command: string, timeout = 30000): Promise<ToolResult> {
    const tokens = this.tokenize(command.trim());
    if (tokens.length === 0) {
      return { success: false, error: 'Command cannot be empty' };
    }

    const [cmd, ...args] = tokens;

    if (BLOCKED_COMMANDS.has(cmd)) {
      return { success: false, error: `Command is blocked by policy: ${cmd}` };
    }

    if (cmd === 'cd') {
      const target = args[0] ?? '.';
      return this.changeDirectory(target);
    }

    if (!ALLOWED_COMMANDS.has(cmd)) {
      return { success: false, error: `Command is not allowed: ${cmd}` };
    }

    if (UNSAFE_SHELL_METACHARS.test(command)) {
      return { success: false, error: 'Command contains unsafe shell metacharacters' };
    }

    return this.executeArgs(cmd, args, timeout, command);
  }

  async executeArgs(
    command: string,
    args: string[] = [],
    timeout = 30000,
    confirmationLabel?: string
  ): Promise<ToolResult> {
    try {
      if (BLOCKED_COMMANDS.has(command)) {
        return { success: false, error: `Command is blocked by policy: ${command}` };
      }

      if (!ALLOWED_COMMANDS.has(command)) {
        return { success: false, error: `Command is not allowed: ${command}` };
      }

      const argsValidation = await this.validateArgs(command, args);
      if (!argsValidation.success) {
        return argsValidation;
      }

      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.bashCommands && !sessionFlags.allOperations) {
        const confirmationResult = await this.confirmationService.requestConfirmation(
          {
            operation: 'Run bash command',
            filename: confirmationLabel || `${command} ${args.join(' ')}`.trim(),
            showVSCodeOpen: false,
            content: `Command: ${command} ${args.join(' ')}\nWorking directory: ${this.currentDirectory}`,
          },
          'bash'
        );

        if (!confirmationResult.confirmed) {
          return {
            success: false,
            error: confirmationResult.feedback || 'Command execution cancelled by user',
          };
        }
      }

      const result = await this.runCommand(command, args, timeout);
      return {
        success: result.code === 0,
        ...(result.output ? { output: result.output } : {}),
        ...(result.code !== 0 ? { error: result.output || `Command failed with exit code ${result.code}` } : {}),
      };
    } catch (error) {
      return {
        success: false,
        error: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async runCommand(command: string, args: string[], timeout: number): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.currentDirectory,
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const appendChunk = (current: string, data: unknown): string => {
        if (truncated) return current;
        const chunk = String(data);
        const next = current + chunk;
        if (next.length <= MAX_OUTPUT_BYTES) {
          return next;
        }

        truncated = true;
        const allowedBytes = Math.max(MAX_OUTPUT_BYTES - current.length, 0);
        const clipped = allowedBytes > 0 ? chunk.slice(0, allowedBytes) : '';
        return `${current}${clipped}\n[output truncated after ${MAX_OUTPUT_BYTES} bytes]`;
      };

      let forceKillTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 1_500);
      }, timeout);

      child.stdout.on('data', (data) => {
        stdout = appendChunk(stdout, data);
      });

      child.stderr.on('data', (data) => {
        stderr = appendChunk(stderr, data);
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({ code: 1, output: error instanceof Error ? error.message : String(error) });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (timedOut) {
          resolve({ code: 124, output: 'Command timed out' });
          return;
        }
        const output = `${stdout}${stderr ? `\nSTDERR: ${stderr}` : ''}`.trim();
        resolve({ code: code as number | null, output });
      });
    });
  }

  private async changeDirectory(newDir: string): Promise<ToolResult> {
    const workspaceRoot = await this.canonicalWorkspaceRootPromise;
    const target = path.resolve(this.currentDirectory, newDir);
    const rootPrefix = workspaceRoot.endsWith('/')
      ? workspaceRoot
      : `${workspaceRoot}/`;
    if (target !== workspaceRoot && !target.startsWith(rootPrefix)) {
      return {
        success: false,
        error: `Cannot change directory outside workspace root: ${newDir}`,
      };
    }

    const exists = await fs.pathExists(target);
    if (!exists) {
      return { success: false, error: `Cannot change directory: path does not exist: ${newDir}` };
    }

    const stats = await fs.stat(target);
    if (!stats.isDirectory()) {
      return { success: false, error: `Cannot change directory: not a directory: ${newDir}` };
    }

    const canonicalTarget = await fs.realpath(target);
    if (canonicalTarget !== workspaceRoot && !canonicalTarget.startsWith(rootPrefix)) {
      return {
        success: false,
        error: `Cannot change directory outside workspace root: ${newDir}`,
      };
    }

    this.currentDirectory = canonicalTarget;
    return { success: true, output: `Changed directory to: ${this.currentDirectory}` };
  }

  private async validateArgs(command: string, args: string[]): Promise<ToolResult> {
    const pathArgCommands = new Set(['ls', 'cat', 'mkdir', 'touch', 'find', 'rg', 'grep']);
    if (!pathArgCommands.has(command)) {
      return { success: true };
    }

    for (const arg of args) {
      if (!arg || arg.startsWith('-')) {
        continue;
      }

      if (arg.includes('\0')) {
        return { success: false, error: 'Command argument contains null byte' };
      }

      if (path.isAbsolute(arg) || arg.split('/').includes('..')) {
        return { success: false, error: `Path argument is not allowed outside workspace: ${arg}` };
      }
    }

    return { success: true };
  }

  private tokenize(command: string): string[] {
    const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
    if (!matches) {
      return [];
    }

    return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }

  async listFiles(directory = '.'): Promise<ToolResult> {
    return this.executeArgs('ls', ['-la', directory]);
  }

  async findFiles(pattern: string, directory = '.'): Promise<ToolResult> {
    return this.executeArgs('find', [directory, '-name', pattern, '-type', 'f']);
  }

  async grep(pattern: string, files = '.'): Promise<ToolResult> {
    return this.executeArgs('grep', ['-r', pattern, files]);
  }
}
