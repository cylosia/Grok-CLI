import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import { createHash } from "crypto";
import { ConfirmationRequestId, asConfirmationRequestId } from "../types/index.js";

const execFileAsync = promisify(execFile);

export interface ConfirmationOptions {
  operation: string;
  filename: string;
  showVSCodeOpen?: boolean;
  content?: string;
}

export interface ConfirmationResult {
  confirmed: boolean;
  dontAskAgain?: boolean;
  feedback?: string;
}

interface PendingConfirmation {
  id: ConfirmationRequestId;
  resolve: (result: ConfirmationResult) => void;
  promise: Promise<ConfirmationResult>;
}


export interface ConfirmationServiceLike {
  requestConfirmation(options: ConfirmationOptions, operationType?: "file" | "bash"): Promise<ConfirmationResult>;
  confirmOperation(confirmed: boolean, dontAskAgain?: boolean, requestId?: ConfirmationRequestId): void;
  rejectOperation(feedback?: string, requestId?: ConfirmationRequestId): void;
  isPending(): boolean;
  resetSession(): void;
}

export class ConfirmationService extends EventEmitter implements ConfirmationServiceLike {
  private static instance: ConfirmationService;
  private static readonly MAX_PENDING_CONFIRMATIONS = 100;
  private static readonly REQUEST_TIMEOUT_MS = 60_000;
  private pendingQueue: PendingConfirmation[] = [];
  private requestCounter = 0;

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

  async requestConfirmation(
    options: ConfirmationOptions,
    operationType: "file" | "bash" = "file"
  ): Promise<ConfirmationResult> {
    if (
      this.sessionFlags.allOperations ||
      (operationType === "file" && this.sessionFlags.fileOperations) ||
      (operationType === "bash" && this.sessionFlags.bashCommands)
    ) {
      return { confirmed: true };
    }

    if (options.showVSCodeOpen) {
      try {
        await this.openInVSCode(options.filename);
      } catch {
        options.showVSCodeOpen = false;
      }
    }

    if (this.pendingQueue.length >= ConfirmationService.MAX_PENDING_CONFIRMATIONS) {
      return {
        confirmed: false,
        feedback: `Too many pending confirmations (>${ConfirmationService.MAX_PENDING_CONFIRMATIONS})`,
      };
    }

    this.requestCounter += 1;
    const requestId = asConfirmationRequestId(createHash("sha256").update(`${Date.now()}_${this.requestCounter}_${options.filename}`).digest("hex"));
    let resolveFn: (result: ConfirmationResult) => void = () => {};
    const promise = new Promise<ConfirmationResult>((resolve) => {
      resolveFn = resolve;
    });

    const timeoutHandle = setTimeout(() => {
      this.resolveRequest({ confirmed: false, feedback: "Confirmation timed out" }, requestId);
    }, ConfirmationService.REQUEST_TIMEOUT_MS);

    this.pendingQueue.push({ id: requestId, resolve: resolveFn, promise });

    setImmediate(() => {
      this.emit("confirmation-requested", { ...options, requestId });
    });

    const result = await promise;
    clearTimeout(timeoutHandle);

    if (result.dontAskAgain) {
      if (operationType === "file") {
        this.sessionFlags.fileOperations = true;
      } else if (operationType === "bash") {
        this.sessionFlags.bashCommands = true;
      }
    }

    return result;
  }

  private resolveRequest(result: ConfirmationResult, requestId?: ConfirmationRequestId): void {
    const queueIndex = requestId
      ? this.pendingQueue.findIndex((request) => request.id === requestId)
      : 0;
    if (queueIndex < 0) {
      return;
    }

    const [request] = this.pendingQueue.splice(queueIndex, 1);
    request.resolve(result);
  }

  confirmOperation(confirmed: boolean, dontAskAgain?: boolean, requestId?: ConfirmationRequestId): void {
    this.resolveRequest({ confirmed, ...(typeof dontAskAgain === "boolean" ? { dontAskAgain } : {}) }, requestId);
  }

  rejectOperation(feedback?: string, requestId?: ConfirmationRequestId): void {
    this.resolveRequest({ confirmed: false, ...(typeof feedback === "string" ? { feedback } : {}) }, requestId);
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

          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
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
    for (const pending of this.pendingQueue) {
      pending.resolve({
        confirmed: false,
        feedback: "Confirmation session reset",
      });
    }

    this.sessionFlags = {
      fileOperations: false,
      bashCommands: false,
      allOperations: false,
    };
    this.pendingQueue = [];
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

export function createConfirmationService(): ConfirmationServiceLike {
  return ConfirmationService.getInstance();
}
