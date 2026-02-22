export class ConcurrencyGate {
  private static readonly IMMEDIATE_LOCK_TIMEOUT_MS = 300_000; // 5 minutes
  private processingQueue: Promise<void> = Promise.resolve();
  private isProcessing = false;
  private hasPendingOperation = false;
  private immediateTimeoutHandle: NodeJS.Timeout | undefined;

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.hasPendingOperation || this.isProcessing) {
      throw new Error("Agent is already processing another request");
    }

    this.hasPendingOperation = true;
    const previous = this.processingQueue;
    let release: () => void = () => {};
    this.processingQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    this.isProcessing = true;
    try {
      return await operation();
    } finally {
      this.isProcessing = false;
      this.hasPendingOperation = false;
      release();
    }
  }

  tryAcquireImmediate(): void {
    if (this.hasPendingOperation || this.isProcessing) {
      throw new Error("Agent is already processing another request");
    }
    this.isProcessing = true;
    this.hasPendingOperation = true;

    // Safety net: auto-release if the holder never calls releaseImmediate
    // (e.g., generator abandoned without draining).
    this.immediateTimeoutHandle = setTimeout(() => {
      this.releaseImmediate();
    }, ConcurrencyGate.IMMEDIATE_LOCK_TIMEOUT_MS);
  }

  releaseImmediate(): void {
    if (this.immediateTimeoutHandle) {
      clearTimeout(this.immediateTimeoutHandle);
      this.immediateTimeoutHandle = undefined;
    }
    this.isProcessing = false;
    this.hasPendingOperation = false;
  }
}
