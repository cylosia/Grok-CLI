declare namespace NodeJS {
  interface Process {
    env: Record<string, string | undefined>;
    argv: string[];
    stdout: { isTTY?: boolean; write: (...args: unknown[]) => boolean };
    stderr: { write: (...args: unknown[]) => boolean };
    cwd(): string;
    chdir(path: string): void;
    exit(code?: number): never;
  }
}

declare const process: NodeJS.Process;
declare const console: {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
declare function setImmediate(callback: (...args: unknown[]) => void): void;

declare class AbortSignal {}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare module "events" {
  class EventEmitter {
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    emit(event: string | symbol, ...args: unknown[]): boolean;
  }
  export { EventEmitter };
}

declare module "child_process" {
  import { EventEmitter } from "events";
  export interface SpawnOptions {
    cwd?: string;
    shell?: boolean;
    detached?: boolean;
    stdio?: string | string[];
    timeout?: number;
    maxBuffer?: number;
  }
  export interface ChildProcess extends EventEmitter {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill(signal?: string): boolean;
    unref(): void;
  }
  export function exec(command: string, options?: SpawnOptions, callback?: (...args: unknown[]) => void): ChildProcess;
  export function execFile(file: string, args?: string[], options?: SpawnOptions, callback?: (...args: unknown[]) => void): ChildProcess;
  export function spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcess;
}

declare module "util" {
  export function promisify<T>(fn: T): (...args: unknown[]) => Promise<any>;
}

declare module "fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
}

declare module "os" {
  export function homedir(): string;
}
