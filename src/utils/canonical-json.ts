function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForCanonicalJson(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, normalizeForCanonicalJson(entry)] as const);
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

