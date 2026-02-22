const MAX_TOOL_ARGS_BYTES = 100_000;
const BLOCKED_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepSanitizeProtoKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepSanitizeProtoKeys);
  }
  if (value && typeof value === "object") {
    const safe = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!BLOCKED_PROTO_KEYS.has(key)) {
        safe[key] = deepSanitizeProtoKeys(entry);
      }
    }
    return safe;
  }
  return value;
}

export function parseToolArgs(argsRaw: string): Record<string, unknown> {
  if (argsRaw.length > MAX_TOOL_ARGS_BYTES) {
    throw new Error(`Tool arguments exceed ${MAX_TOOL_ARGS_BYTES} bytes`);
  }

  const parsed = JSON.parse(argsRaw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }

  // Recursively sanitize prototype-pollution keys from LLM-generated JSON
  return deepSanitizeProtoKeys(parsed) as Record<string, unknown>;
}

export function safeSerializeToolData(data: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(data ?? {}, (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) {
          return "[CIRCULAR]";
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    return "[unserializable tool payload]";
  }
}

export function isTodoItem(value: unknown): value is { id: string; content: string; status: "pending" | "in_progress" | "completed"; priority: "high" | "medium" | "low" } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.content === "string"
    && (record.status === "pending" || record.status === "in_progress" || record.status === "completed")
    && (record.priority === "high" || record.priority === "medium" || record.priority === "low");
}

export function isTodoUpdate(value: unknown): value is { id: string; status?: "pending" | "in_progress" | "completed"; content?: string; priority?: "high" | "medium" | "low" } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && (record.status === undefined || record.status === "pending" || record.status === "in_progress" || record.status === "completed")
    && (record.content === undefined || typeof record.content === "string")
    && (record.priority === undefined || record.priority === "high" || record.priority === "medium" || record.priority === "low");
}
