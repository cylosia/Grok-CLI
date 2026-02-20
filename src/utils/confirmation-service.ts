import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";

const execFileAsync = promisify(execFile);

export interface ConfirmationOptions {
  operation: string;
  filename: string;
  showVSCodeOpen?: boolean;
  content?: string; // Content to show in confirmation dialog
}

export interface ConfirmationResult {
  confirmed: boolean;
  dontAskAgain?: boolean;
  feedback?: string;
}

interface PendingConfirmation {
  id: string;
  resolve: (result: ConfirmationResult) => void;
}

export class ConfirmationService extends EventEmitter {
  private static instance: ConfirmationService;
  private pendingConfirmation: Promise<ConfirmationResult> | null = null;
  private pendingQueue: PendingConfirmation[] = [];

  // Session flags for different operation types
  private sessionFlags = {
    fileOperations: false,
    bashCommands: false,
    allOperations: false,
  };

  static getInstance(): ConfirmationService {
    if (!ConfirmationService.instance) {
      ConfirmationService.instance = new ConfirmationService();
    }
    return ConfirmationService.instance;
  }

  constructor() {
    super();
  }

  async requestConfirmation(
    options: ConfirmationOptions,
    operationType: "file" | "bash" = "file"
  ): Promise<ConfirmationResult> {
    // Check session flags
    if (
      this.sessionFlags.allOperations ||
      (operationType === "file" && this.sessionFlags.fileOperations) ||
      (operationType === "bash" && this.sessionFlags.bashCommands)
    ) {
      return { confirmed: true };
    }

    // If VS Code should be opened, try to open it
    if (options.showVSCodeOpen) {
      try {
        await this.openInVSCode(options.filename);
      } catch (error) {
        // If VS Code opening fails, continue without it
        options.showVSCodeOpen = false;
      }
    }

    // Create a promise that will be resolved by the UI component
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.pendingConfirmation = new Promise<ConfirmationResult>((resolve) => {
      this.pendingQueue.push({ id: requestId, resolve });
    });

    // Emit custom event that the UI can listen to (using setImmediate to ensure the UI updates)
    setImmediate(() => {
      this.emit("confirmation-requested", { ...options, requestId });
    });

    const result = await this.pendingConfirmation;

    if (result.dontAskAgain) {
      // Set the appropriate session flag based on operation type
      if (operationType === "file") {
        this.sessionFlags.fileOperations = true;
      } else if (operationType === "bash") {
        this.sessionFlags.bashCommands = true;
      }
      // Could also set allOperations for global skip
    }

    return result;
  }

  private resolveRequest(result: ConfirmationResult, requestId?: string): void {
    const queueIndex = requestId
      ? this.pendingQueue.findIndex((request) => request.id === requestId)
      : 0;
    if (queueIndex < 0) {
      return;
    }

    const [request] = this.pendingQueue.splice(queueIndex, 1);
    request.resolve(result);
    this.pendingConfirmation = this.pendingQueue.length > 0 ? this.pendingConfirmation : null;
  }

  confirmOperation(confirmed: boolean, dontAskAgain?: boolean, requestId?: string): void {
    this.resolveRequest({ confirmed, dontAskAgain }, requestId);
  }

  rejectOperation(feedback?: string, requestId?: string): void {
    this.resolveRequest({ confirmed: false, feedback }, requestId);
  }

  private async openInVSCode(filename: string): Promise<void> {
    const commands = ["code", "code-insiders", "codium"];

    for (const cmd of commands) {
      try {
        await execFileAsync("which", [cmd]);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(cmd, [filename], {
            stdio: "ignore",
            detached: true,
            shell: false,
          });

          child.on("error", reject);
          child.unref();
          resolve();
        });

        return;
      } catch {
        continue;
      }
    }

    throw new Error("VS Code not found");
  }

  isPending(): boolean {
    return this.pendingQueue.length > 0;
  }

  resetSession(): void {
    this.sessionFlags = {
      fileOperations: false,
      bashCommands: false,
      allOperations: false,
    };
    this.pendingQueue = [];
    this.pendingConfirmation = null;
  }

  getSessionFlags() {
    return { ...this.sessionFlags };
  }

  setSessionFlag(
    flagType: "fileOperations" | "bashCommands" | "allOperations",
    value: boolean
  ) {
    this.sessionFlags[flagType] = value;
  }
}
