export interface LogContext {
  component?: string;
  action?: string;
  [key: string]: unknown;
}

function emit(level: "info" | "warn" | "error", message: string, context: LogContext = {}): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    correlationId: process.env.GROK_CORRELATION_ID ?? undefined,
    ...context,
  };

  const line = JSON.stringify(payload);
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
