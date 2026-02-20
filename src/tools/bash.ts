import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ToolResult } from '../types/index.js';
import { ConfirmationService } from '../utils/confirmation-service.js';

const ALLOWED_COMMANDS = new Set([
  'git', 'ls', 'pwd', 'cat', 'mkdir', 'touch', 'echo', 'grep', 'find', 'rg'
]);

const BLOCKED_COMMANDS = new Set(['rm', 'mv', 'cp', 'node', 'npm']);
const BLOCKED_FLAGS_BY_COMMAND: Record<string, Set<string>> = {
  find: new Set(['-exec', '-execdir', '-ok', '-okdir']),
  rg: new Set(['--pre', '--pre-glob', '--no-ignore-files', '--ignore-file']),
  grep: new Set(['--include-from', '--exclude-from', '-f']),
  git: new Set(['-c']),
};

const PATH_FLAGS_BY_COMMAND: Record<string, Set<string>> = {
  git: new Set(['-C']),
  rg: new Set(['--ignore-file', '--pre']),
  grep: new Set(['--exclude-from', '--include-from', '-f']),
  find: new Set([]),
  ls: new Set([]),
  cat: new Set([]),
  mkdir: new Set([]),
  touch: new Set([]),
  echo: new Set([]),
  pwd: new Set([]),
};

const UNSAFE_SHELL_METACHARS = /[;&|><`\n\r]/;
const MAX_OUTPUT_BYTES = 1_000_000;

export class BashTool {
  private workspaceRoot: string = process.cwd();
  private currentDirectory: string = process.cwd();
  private canonicalWorkspaceRootPromise: Promise<string>;
  private confirmationService = ConfirmationService.getInstance();

  private isWithinWorkspace(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

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

      const commandSpecificValidation = this.validateCommandSpecificArgs(command, args);
      if (!commandSpecificValidation.success) {
        return commandSpecificValidation;
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
    const canonicalTarget = await fs.realpath(target).catch(() => target);
    if (!this.isWithinWorkspace(workspaceRoot, canonicalTarget)) {
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

    if (!this.isWithinWorkspace(workspaceRoot, canonicalTarget)) {
      return {
        success: false,
        error: `Cannot change directory outside workspace root: ${newDir}`,
      };
    }

    this.currentDirectory = canonicalTarget;
    return { success: true, output: `Changed directory to: ${this.currentDirectory}` };
  }

  private async validateArgs(command: string, args: string[]): Promise<ToolResult> {
    const pathArgCommands = new Set(['ls', 'cat', 'mkdir', 'touch', 'find', 'rg', 'grep', 'git']);
    if (!pathArgCommands.has(command)) {
      return { success: true };
    }

    const pathFlags = PATH_FLAGS_BY_COMMAND[command] ?? new Set<string>();
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg) {
        continue;
      }

      if (arg.startsWith('-')) {
        let normalized = arg.split('=')[0];
        let inlineValue = arg.includes('=') ? arg.split('=').slice(1).join('=') : undefined;

        if (!pathFlags.has(normalized)) {
          for (const candidate of pathFlags) {
            if (candidate.length === 2 && arg.startsWith(candidate) && arg.length > candidate.length) {
              normalized = candidate;
              inlineValue = arg.slice(candidate.length);
              break;
            }
          }
        }

        if (pathFlags.has(normalized)) {
          const value = inlineValue ?? args[index + 1];
          if (!value) {
            return { success: false, error: `Missing value for path-bearing flag ${normalized}` };
          }

          const pathValidation = await this.validatePathArg(value);
          if (!pathValidation.success) {
            return pathValidation;
          }

          if (!inlineValue) {
            index += 1;
          }
        }
        continue;
      }

      const pathValidation = await this.validatePathArg(arg);
      if (!pathValidation.success) {
        return pathValidation;
      }
    }

    return { success: true };
  }

  private async validatePathArg(arg: string): Promise<ToolResult> {
    if (!arg) {
      return { success: true };
    }

    if (arg.includes('\0')) {
      return { success: false, error: 'Command argument contains null byte' };
    }

    const normalized = path.normalize(arg);
    const segments = normalized.split(/[\\/]+/).filter((segment) => segment.length > 0);

    if (path.isAbsolute(arg) || segments.includes('..')) {
      return { success: false, error: `Path argument is not allowed outside workspace: ${arg}` };
    }

    const workspaceRoot = await this.canonicalWorkspaceRootPromise;
    const resolvedPath = path.resolve(this.currentDirectory, arg);
    const canonicalCandidate = await this.canonicalizePathForValidation(resolvedPath);
    const rootPrefix = workspaceRoot.endsWith(path.sep)
      ? workspaceRoot
      : `${workspaceRoot}${path.sep}`;
    if (canonicalCandidate !== workspaceRoot && !canonicalCandidate.startsWith(rootPrefix)) {
      return { success: false, error: `Path argument is not allowed outside workspace: ${arg}` };
    }

    return { success: true };
  }

  private async canonicalizePathForValidation(targetPath: string): Promise<string> {
    try {
      return await fs.realpath(targetPath);
    } catch {
      const relative = path.relative(this.currentDirectory, targetPath);
      let cursor = targetPath;
      while (cursor !== path.dirname(cursor)) {
        if (await fs.pathExists(cursor)) {
          const canonicalExisting = await fs.realpath(cursor);
          const remainder = path.relative(cursor, targetPath);
          return path.resolve(canonicalExisting, remainder);
        }
        cursor = path.dirname(cursor);
      }

      const canonicalCwd = await fs.realpath(this.currentDirectory).catch(() => this.currentDirectory);
      return path.resolve(canonicalCwd, relative);
    }
  }

  private validateCommandSpecificArgs(command: string, args: string[]): ToolResult {
    const blocked = BLOCKED_FLAGS_BY_COMMAND[command];
    if (!blocked) {
      return { success: true };
    }

    for (const arg of args) {
      const normalized = arg.split('=')[0];
      if (blocked.has(normalized)) {
        return {
          success: false,
          error: `Flag is blocked by policy for ${command}: ${normalized}`,
        };
      }
    }

    return { success: true };
  }

  private tokenize(command: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let escaping = false;

    for (const char of command) {
      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (quote) {
        if (char === quote) {
          quote = null;
        } else {
          current += char;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (/\s/.test(char)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        continue;
      }

      current += char;
    }

    if (escaping || quote) {
      return [];
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
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
