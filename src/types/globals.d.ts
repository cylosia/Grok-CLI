declare namespace NodeJS {
  interface Process {
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }
}
