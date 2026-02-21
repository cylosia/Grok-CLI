import { MCPServerName } from "../types/index.js";

interface CallSafetyOptions {
  timedOutCallCooldownMs: number;
  remotelyUncertainTtlMs: number;
  maxRemotelyUncertainKeys: number;
  maxTimedOutCooldownKeys: number;
}

export class MCPCallSafety {
  private readonly timedOutCallCooldownUntil = new Map<string, number>();
  private readonly remotelyUncertainCallKeys = new Map<string, number>();
  private readonly serverCallQuarantineUntil = new Map<MCPServerName, number>();

  constructor(private readonly options: CallSafetyOptions) {}

  assertCallAllowed(callKey: string, name: string): void {
    this.pruneRemotelyUncertainCallKeys();
    this.pruneTimedOutCooldownKeys();

    if (this.remotelyUncertainCallKeys.has(callKey)) {
      throw new Error(`MCP tool call was previously timed out and may have completed remotely; retry blocked for safety: ${name}`);
    }

    const until = this.timedOutCallCooldownUntil.get(callKey) ?? 0;
    const now = Date.now();
    if (until > now) {
      throw new Error(`MCP tool call is cooling down after a timeout: ${name}`);
    }
    if (until !== 0) {
      this.timedOutCallCooldownUntil.delete(callKey);
    }
  }

  assertServerAllowed(serverName: MCPServerName, name: string): void {
    const now = Date.now();
    const quarantineUntil = this.serverCallQuarantineUntil.get(serverName) ?? 0;
    if (quarantineUntil > now) {
      throw new Error(`MCP server is temporarily quarantined after uncertain timeout state; call blocked: ${name}`);
    }

    if (quarantineUntil !== 0) {
      this.serverCallQuarantineUntil.delete(serverName);
    }
  }

  registerTimeout(callKey: string, serverName: MCPServerName): void {
    this.timedOutCallCooldownUntil.set(callKey, Date.now() + this.options.timedOutCallCooldownMs);
    this.pruneTimedOutCooldownKeys();
    this.markRemotelyUncertain(callKey);
    this.serverCallQuarantineUntil.set(serverName, Date.now() + this.options.timedOutCallCooldownMs);
  }

  clearSuccess(callKey: string, serverName: MCPServerName): void {
    this.remotelyUncertainCallKeys.delete(callKey);
    this.serverCallQuarantineUntil.delete(serverName);
  }

  private pruneTimedOutCooldownKeys(): void {
    const now = Date.now();
    for (const [key, until] of this.timedOutCallCooldownUntil.entries()) {
      if (until <= now) {
        this.timedOutCallCooldownUntil.delete(key);
      }
    }

    while (this.timedOutCallCooldownUntil.size > this.options.maxTimedOutCooldownKeys) {
      const oldest = this.timedOutCallCooldownUntil.keys().next().value;
      if (!oldest) {
        break;
      }
      this.timedOutCallCooldownUntil.delete(oldest);
    }
  }

  private markRemotelyUncertain(callKey: string): void {
    this.pruneRemotelyUncertainCallKeys();
    if (this.remotelyUncertainCallKeys.size >= this.options.maxRemotelyUncertainKeys) {
      let oldestKey: string | undefined;
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const [key, expiry] of this.remotelyUncertainCallKeys.entries()) {
        if (expiry < oldestExpiry) {
          oldestExpiry = expiry;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.remotelyUncertainCallKeys.delete(oldestKey);
      }
    }

    this.remotelyUncertainCallKeys.set(callKey, Date.now() + this.options.remotelyUncertainTtlMs);
  }

  private pruneRemotelyUncertainCallKeys(): void {
    const now = Date.now();
    for (const [key, expiry] of this.remotelyUncertainCallKeys.entries()) {
      if (expiry <= now) {
        this.remotelyUncertainCallKeys.delete(key);
      }
    }
  }
}
