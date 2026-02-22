import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ToolResult } from '../types/index.js';
import { ConfirmationService } from '../utils/confirmation-service.js';
import { isWithinRoot } from './path-safety.js';
import { hasUnterminatedQuoteOrEscape, tokenizeBashLikeCommand } from './bash-tokenizer.js';
import { killProcessTree } from '../utils/process-tree.js';
import {
  ALLOWED_COMMANDS,
  BLOCKED_COMMANDS,
  BLOCKED_FLAGS_BY_COMMAND,
  GIT_ALLOWED_MUTATING_SUBCOMMANDS,
  GIT_ALLOWED_READONLY_SUBCOMMANDS,
  GIT_BLOCKED_DESTRUCTIVE_SUBCOMMANDS,
  GIT_PATH_BEARING_FLAGS,
  MAX_FIND_DEPTH,
  MAX_OUTPUT_BYTES,
  MAX_SEARCH_MATCHES,
  PATH_ARG_COMMANDS,
  PATH_FLAGS_BY_COMMAND,
  UNSAFE_SHELL_METACHARS,
} from './bash-policy.js';

export class BashTool {
  private workspaceRoot: string = process.cwd();
  private currentDirectory: string = process.cwd();
  private canonicalWorkspaceRootPromise: Promise<string>;
  private confirmationService = ConfirmationService.getInstance();

  private isWithinWorkspace(root: string, candidate: string): boolean {
    return isWithinRoot(root, candidate);
  }

  constructor() {
    this.canonicalWorkspaceRootPromise = fs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot);
  }

  async execute(command: string, timeout = 30000): Promise<ToolResult> {
    const trimmedCommand = command.trim();
    const tokens = tokenizeBashLikeCommand(trimmedCommand);
    if (tokens.length === 0) {
      if (hasUnterminatedQuoteOrEscape(trimmedCommand)) {
        return { success: false, error: 'Command contains unterminated quote or escape sequence' };
      }
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

  /**
   * Execute a command with pre-split arguments.  Unlike `execute()`, this
   * skips the tokenizer and UNSAFE_SHELL_METACHARS check because it spawns
   * with `shell: false`, so metacharacters are passed as literal strings and
   * cannot trigger shell interpretation.  All other security controls
   * (allowlist, blocked-commands, blocked-flags, path validation, confirmation
   * service, symlink checks) are enforced identically.
   */
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

      const gitSubcommand = command === 'git' ? this.getGitSubcommand(args) : undefined;

      const normalizedArgs = await this.normalizeCommandArgs(command, args);

      const commandSpecificValidation = this.validateCommandSpecificArgs(command, args);
      if (!commandSpecificValidation.success) {
        return commandSpecificValidation;
      }

      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.bashCommands && !sessionFlags.allOperations) {
        const confirmationResult = await this.confirmationService.requestConfirmation(
              {
            operation: 'Run bash command',
            filename: confirmationLabel || `${command} ${normalizedArgs.join(' ')}`.trim(),
            showVSCodeOpen: false,
            content: `Command: ${command} ${normalizedArgs.join(' ')}\nWorking directory: ${this.currentDirectory}`,
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

      if (command === 'git' && gitSubcommand && GIT_ALLOWED_MUTATING_SUBCOMMANDS.has(gitSubcommand)) {
        const mutationConfirmation = await this.confirmationService.requestConfirmation(
          {
            operation: `Run mutating git command (${gitSubcommand})`,
            filename: confirmationLabel || `${command} ${normalizedArgs.join(' ')}`.trim(),
            showVSCodeOpen: false,
            content: `Mutating git command detected:\n${command} ${normalizedArgs.join(' ')}\nWorking directory: ${this.currentDirectory}`,
          },
          'bash'
        );
        if (!mutationConfirmation.confirmed) {
          return {
            success: false,
            error: mutationConfirmation.feedback || 'Mutating git command cancelled by user',
          };
        }
      }

      const preflight = await this.revalidateResolvedArgs(command, normalizedArgs);
      if (!preflight.success) {
        return preflight;
      }

      const result = await this.runCommand(command, normalizedArgs, timeout);
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

  private async revalidateResolvedArgs(command: string, args: string[]): Promise<ToolResult> {
    if (!PATH_ARG_COMMANDS.has(command) && command !== "git") {
      return { success: true };
    }

    const pathArgs = this.collectNormalizedPathArgs(command, args);
    for (const candidate of pathArgs) {
      const validation = await this.validateCanonicalPathAtExecution(candidate);
      if (!validation.success) {
        return validation;
      }
    }

    return { success: true };
  }

  private collectNormalizedPathArgs(command: string, args: string[]): string[] {
    const results: string[] = [];

    if (command === "git") {
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg) continue;
        if (arg === "--") {
          for (let pathIndex = index + 1; pathIndex < args.length; pathIndex += 1) {
            const candidate = args[pathIndex];
            if (candidate && !candidate.startsWith("-")) results.push(candidate);
          }
          break;
        }

        const [normalizedFlag] = arg.split("=");
        const inlineValue = arg.includes("=") ? arg.split("=").slice(1).join("=") : undefined;
        if (GIT_PATH_BEARING_FLAGS.has(normalizedFlag) || arg === "-C" || arg.startsWith("-C")) {
          const gitShortInline = arg.startsWith("-C") && arg.length > 2 && !arg.includes("=") ? arg.slice(2) : undefined;
          const value = inlineValue ?? gitShortInline ?? args[index + 1];
          if (value) results.push(value);
          if (!inlineValue && !gitShortInline) {
            index += 1;
          }
        }
      }
      return results;
    }

    const pathFlags = PATH_FLAGS_BY_COMMAND[command] ?? new Set<string>();
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg) continue;

      if (arg.startsWith("-")) {
        let normalized = arg.split("=")[0];
        let inlineValue = arg.includes("=") ? arg.split("=").slice(1).join("=") : undefined;
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
          if (value) results.push(value);
          if (!inlineValue) index += 1;
        }
        continue;
      }

      results.push(arg);
    }

    return results;
  }

  private async validateCanonicalPathAtExecution(candidate: string): Promise<ToolResult> {
    if (!path.isAbsolute(candidate)) {
      return { success: false, error: `Path argument must be canonicalized before execution: ${candidate}` };
    }

    const workspaceRoot = await this.canonicalWorkspaceRootPromise;
    if (!this.isWithinWorkspace(workspaceRoot, candidate)) {
      return { success: false, error: `Path argument is not allowed outside workspace: ${candidate}` };
    }

    let cursor = candidate;
    while (true) {
      try {
        const stats = await fs.lstat(cursor);
        if (stats.isSymbolicLink()) {
          return { success: false, error: `Symbolic link path arguments are blocked at execution time: ${candidate}` };
        }
      } catch {
        // ignore missing path components
      }
      const parent = path.dirname(cursor);
      if (parent === cursor || !this.isWithinWorkspace(workspaceRoot, parent)) {
        break;
      }
      cursor = parent;
    }

    return { success: true };
  }

  private async runCommand(command: string, args: string[], timeout: number): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.currentDirectory,
        shell: false,
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let totalOutputBytes = 0;
      let truncated = false;
      let timedOut = false;

      const appendChunk = (current: string, data: unknown): string => {
        if (truncated) return current;
        const chunk = String(data);
        const chunkBytes = Buffer.byteLength(chunk, 'utf8');
        if (totalOutputBytes + chunkBytes <= MAX_OUTPUT_BYTES) {
          totalOutputBytes += chunkBytes;
          return current + chunk;
        }

        truncated = true;
        const allowedBytes = Math.max(MAX_OUTPUT_BYTES - totalOutputBytes, 0);
        const clipped = Buffer.from(chunk, 'utf8').subarray(0, allowedBytes).toString('utf8');
        totalOutputBytes = MAX_OUTPUT_BYTES;
        return `${current}${clipped}\n[output truncated after ${MAX_OUTPUT_BYTES} bytes]`;
      };

      let forceKillTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid ?? 0, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          killProcessTree(child.pid ?? 0, 'SIGKILL');
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

  private async validateGitArgs(args: string[]): Promise<ToolResult> {
    const firstNonFlag = this.getGitSubcommand(args);

    if (!firstNonFlag) {
      return {
        success: false,
        error: `Git subcommand is not allowed by policy: ${firstNonFlag ?? 'none'}`,
      };
    }

    if (GIT_BLOCKED_DESTRUCTIVE_SUBCOMMANDS.has(firstNonFlag)) {
      return {
        success: false,
        error: `Git subcommand is blocked by policy: ${firstNonFlag}`,
      };
    }

    if (!GIT_ALLOWED_READONLY_SUBCOMMANDS.has(firstNonFlag) && !GIT_ALLOWED_MUTATING_SUBCOMMANDS.has(firstNonFlag)) {
      return {
        success: false,
        error: `Git subcommand is not allowed by policy: ${firstNonFlag}`,
      };
    }

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg) {
        continue;
      }

      if (arg === "--") {
        for (let pathIndex = index + 1; pathIndex < args.length; pathIndex += 1) {
          const pathArg = args[pathIndex];
          if (!pathArg || pathArg.startsWith("-")) {
            continue;
          }
          const pathValidation = await this.validatePathArg(pathArg);
          if (!pathValidation.success) {
            return pathValidation;
          }
        }
        break;
      }

      const [normalized] = arg.split('=');
      const explicitInline = arg.includes('=') ? arg.split('=').slice(1).join('=') : undefined;
      if (GIT_PATH_BEARING_FLAGS.has(normalized) || arg === '-C' || arg.startsWith('-C')) {
        const inlineValue = explicitInline ?? (arg.startsWith('-C') && arg.length > 2 ? arg.slice(2) : undefined);
        const value = inlineValue ?? args[index + 1];
        if (!value) {
          return { success: false, error: `Missing value for path-bearing flag ${normalized}` };
        }
        const pathValidation = await this.validatePathArg(value);
        if (!pathValidation.success) {
          return pathValidation;
        }
        if (!inlineValue && !arg.includes('=')) {
          index += 1;
        }
      }
    }

    return { success: true };
  }

  private async validateArgs(command: string, args: string[]): Promise<ToolResult> {
    if (command === 'git') {
      return this.validateGitArgs(args);
    }

    if (!PATH_ARG_COMMANDS.has(command)) {
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

  private async normalizeCommandArgs(command: string, args: string[]): Promise<string[]> {
    if (command === 'git') {
      return this.normalizeGitArgs(args);
    }
    if (!PATH_ARG_COMMANDS.has(command)) {
      return [...args];
    }

    const normalizedArgs = [...args];
    const pathFlags = PATH_FLAGS_BY_COMMAND[command] ?? new Set<string>();

    for (let index = 0; index < normalizedArgs.length; index += 1) {
      const arg = normalizedArgs[index];
      if (!arg) continue;

      if (arg.startsWith('-')) {
        let normalizedFlag = arg.split('=')[0];
        let inlineValue = arg.includes('=') ? arg.split('=').slice(1).join('=') : undefined;

        if (!pathFlags.has(normalizedFlag)) {
          for (const candidate of pathFlags) {
            if (candidate.length === 2 && arg.startsWith(candidate) && arg.length > candidate.length) {
              normalizedFlag = candidate;
              inlineValue = arg.slice(candidate.length);
              break;
            }
          }
        }

        if (pathFlags.has(normalizedFlag)) {
          const value = inlineValue ?? normalizedArgs[index + 1];
          if (!value) continue;
          const canonicalPath = await this.normalizeSafePathArg(value);
          if (inlineValue) {
            normalizedArgs[index] = `${normalizedFlag}${normalizedFlag.length === 2 ? '' : '='}${canonicalPath}`;
          } else {
            normalizedArgs[index + 1] = canonicalPath;
            index += 1;
          }
        }
        continue;
      }

      normalizedArgs[index] = await this.normalizeSafePathArg(arg);
    }

    return normalizedArgs;
  }

  private async normalizeGitArgs(args: string[]): Promise<string[]> {
    const normalizedArgs = [...args];
    for (let index = 0; index < normalizedArgs.length; index += 1) {
      const arg = normalizedArgs[index];
      if (!arg) continue;

      if (arg === '--') {
        for (let pathIndex = index + 1; pathIndex < normalizedArgs.length; pathIndex += 1) {
          const pathArg = normalizedArgs[pathIndex];
          if (!pathArg || pathArg.startsWith('-')) continue;
          normalizedArgs[pathIndex] = await this.normalizeSafePathArg(pathArg);
        }
        break;
      }

      const [normalizedFlag] = arg.split('=');
      const explicitInline = arg.includes('=') ? arg.split('=').slice(1).join('=') : undefined;
      if (GIT_PATH_BEARING_FLAGS.has(normalizedFlag) || arg === '-C' || arg.startsWith('-C')) {
        const inlineValue = explicitInline ?? (arg.startsWith('-C') && arg.length > 2 ? arg.slice(2) : undefined);
        const value = inlineValue ?? normalizedArgs[index + 1];
        if (!value) continue;
        const canonicalPath = await this.normalizeSafePathArg(value);
        if (inlineValue) {
          if (arg.startsWith('-C') && arg.length > 2 && !arg.includes('=')) {
            normalizedArgs[index] = `-C${canonicalPath}`;
          } else {
            normalizedArgs[index] = `${normalizedFlag}=${canonicalPath}`;
          }
        } else {
          normalizedArgs[index + 1] = canonicalPath;
          index += 1;
        }
      }
    }
    return normalizedArgs;
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

  private async normalizeSafePathArg(arg: string): Promise<string> {
    const workspaceRoot = await this.canonicalWorkspaceRootPromise;
    const resolvedPath = path.resolve(this.currentDirectory, arg);
    const canonicalCandidate = await this.canonicalizePathForValidation(resolvedPath);
    const rootPrefix = workspaceRoot.endsWith(path.sep)
      ? workspaceRoot
      : `${workspaceRoot}${path.sep}`;
    if (canonicalCandidate !== workspaceRoot && !canonicalCandidate.startsWith(rootPrefix)) {
      throw new Error(`Path argument is not allowed outside workspace: ${arg}`);
    }
    return canonicalCandidate;
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
    if (blocked) {
      for (const arg of args) {
        const normalized = arg.split('=')[0];
        if (blocked.has(normalized)) {
          return {
            success: false,
            error: `Flag is blocked by policy for ${command}: ${normalized}`,
          };
        }
      }
    }

    const readNumericFlagValue = (flagName: string): number | undefined => {
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === flagName) {
          const nextValue = args[index + 1];
          if (!nextValue) {
            return Number.NaN;
          }
          return Number(nextValue);
        }
        if (arg.startsWith(`${flagName}=`)) {
          return Number(arg.slice(flagName.length + 1));
        }
      }
      return undefined;
    };

    if (command === 'find') {
      const maxDepth = readNumericFlagValue('-maxdepth');
      if (maxDepth === undefined || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_FIND_DEPTH) {
        return {
          success: false,
          error: `find requires -maxdepth as an integer between 0 and ${MAX_FIND_DEPTH}`,
        };
      }
    }

    if (command === 'grep' || command === 'rg') {
      const maxCount = readNumericFlagValue('--max-count');
      if (maxCount === undefined || !Number.isInteger(maxCount) || maxCount < 1 || maxCount > MAX_SEARCH_MATCHES) {
        return {
          success: false,
          error: `${command} requires --max-count as an integer between 1 and ${MAX_SEARCH_MATCHES}`,
        };
      }
    }

    return { success: true };
  }

  private getGitSubcommand(args: string[]): string | undefined {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg) continue;
      const normalized = arg.split('=')[0];
      const flagConsumesNext = GIT_PATH_BEARING_FLAGS.has(normalized)
        && !arg.includes('=')
        && !(arg.startsWith('-C') && arg.length > 2);

      if (flagConsumesNext) {
        index += 1;
        continue;
      }

      if (!arg.startsWith('-')) {
        return arg;
      }
    }

    return undefined;
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }

  async listFiles(directory = '.'): Promise<ToolResult> {
    return this.executeArgs('ls', ['-la', directory]);
  }

  async findFiles(pattern: string, directory = '.'): Promise<ToolResult> {
    return this.executeArgs('find', [directory, '-maxdepth', String(MAX_FIND_DEPTH), '-name', pattern, '-type', 'f']);
  }

  async grep(pattern: string, files = '.'): Promise<ToolResult> {
    return this.executeArgs('grep', ['-r', '--max-count', String(MAX_SEARCH_MATCHES), pattern, files]);
  }
}
