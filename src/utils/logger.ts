export interface LogContext {
  component?: string;
  action?: string;
  [key: string]: unknown;
}

const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN = /(api[-_]?key|token|authorization|password|secret|cookie|session)/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (SECRET_KEY_PATTERN.test(key)) {
          return [key, REDACTED];
        }
        return [key, sanitize(child, depth + 1)];
      })
    );
  }
  if (typeof value === "string" && value.length > 4096) {
    return `${value.slice(0, 4096)}...[TRUNCATED]`;
  }
  return value;
}

export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }
    if (currentValue && typeof currentValue === "object") {
      if (seen.has(currentValue)) {
        return "[CIRCULAR]";
      }
      seen.add(currentValue);
    }
    return currentValue;
  });
}

function emit(level: "info" | "warn" | "error", message: string, context: LogContext = {}): void {
  const payload = sanitize({
    timestamp: new Date().toISOString(),
    level,
    message,
    correlationId: process.env.GROK_CORRELATION_ID ?? undefined,
    ...context,
  });

  let line: string;
  try {
    line = safeJsonStringify(payload);
  } catch (error) {
    line = safeJsonStringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "logger-serialization-failed",
      originalLevel: level,
      originalMessage: message,
      component: context.component,
      correlationId: process.env.GROK_CORRELATION_ID ?? undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export const logger = {
  info: (message: string, context?: LogContext) => emit("info", message, context),
  warn: (message: string, context?: LogContext) => emit("warn", message, context),
  error: (message: string, context?: LogContext) => emit("error", message, context),
};
