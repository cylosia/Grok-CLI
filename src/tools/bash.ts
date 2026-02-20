import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { ToolResult } from '../types/index.js';
import { ConfirmationService } from '../utils/confirmation-service.js';

const ALLOWED_COMMANDS = new Set([
  'git', 'ls', 'pwd', 'cat', 'mkdir', 'touch', 'echo', 'grep', 'find', 'cp', 'mv', 'rm', 'rg', 'npm', 'node'
]);

const UNSAFE_SHELL_METACHARS = /[;&|><`\n\r]/;

export class BashTool {
  private currentDirectory: string = process.cwd();
  private confirmationService = ConfirmationService.getInstance();

  async execute(command: string, timeout = 30000): Promise<ToolResult> {
    const tokens = this.tokenize(command.trim());
    if (tokens.length === 0) {
      return { success: false, error: 'Command cannot be empty' };
    }

    const [cmd, ...args] = tokens;
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
        output: result.output || undefined,
        error: result.code === 0 ? undefined : result.output || `Command failed with exit code ${result.code}`,
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
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeout);

      child.stdout.on('data', (data) => {
        stdout += String(data);
      });

      child.stderr.on('data', (data) => {
        stderr += String(data);
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 1, output: error instanceof Error ? error.message : String(error) });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
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
    const target = path.resolve(this.currentDirectory, newDir);
    const exists = await fs.pathExists(target);
    if (!exists) {
      return { success: false, error: `Cannot change directory: path does not exist: ${newDir}` };
    }

    const stats = await fs.stat(target);
    if (!stats.isDirectory()) {
      return { success: false, error: `Cannot change directory: not a directory: ${newDir}` };
    }

    this.currentDirectory = target;
    return { success: true, output: `Changed directory to: ${this.currentDirectory}` };
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
