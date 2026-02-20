function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((segment) => Number(segment));
  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value))) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.includes(":")) {
    return isPrivateIpv6(normalized);
  }
  return isPrivateIpv4(normalized);
}

export function validateMcpUrl(rawUrl: string, allowLocalHttp = false): string {
  const normalized = rawUrl.trim();

  const URLCtor = (globalThis as { URL?: new (input: string) => { protocol: string; hostname: string; toString(): string } }).URL;
  if (!URLCtor) {
    throw new Error("URL parser is not available in this runtime");
  }

  let parsed: { protocol: string; hostname: string; toString(): string };
  try {
    parsed = new URLCtor(normalized);
  } catch {
    throw new Error(`Invalid MCP URL: ${rawUrl}`);
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    throw new Error(`Unsupported MCP URL scheme: ${scheme}:`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new Error(`Invalid MCP URL host: ${rawUrl}`);
  }

  const isPrivate = isPrivateHost(host);
  if (scheme === "http") {
    if (!allowLocalHttp || !isPrivate) {
      throw new Error("HTTP MCP URLs are restricted to explicitly-allowed local endpoints");
    }
  }

  if (scheme === "https" && isPrivate && !allowLocalHttp) {
    throw new Error("Private-network MCP URLs require explicit local-network opt-in");
  }

  return parsed.toString();
}
