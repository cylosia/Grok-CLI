function normalizeForCanonicalJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value.map((entry) => normalizeForCanonicalJson(entry, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, normalizeForCanonicalJson(entry, seen)] as const);
    return Object.fromEntries(entries);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

