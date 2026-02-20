declare namespace NodeJS {
  interface Process {
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }
}

declare function setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout;
declare function clearTimeout(timeoutId: NodeJS.Timeout | undefined): void;
declare function setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout;
declare function clearInterval(intervalId: NodeJS.Timeout | undefined): void;
