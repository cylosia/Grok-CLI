export class ConcurrencyGate {
  private processingQueue: Promise<void> = Promise.resolve();
  private isProcessing = false;
  private hasPendingOperation = false;

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
  }

  releaseImmediate(): void {
    this.isProcessing = false;
  }
}
