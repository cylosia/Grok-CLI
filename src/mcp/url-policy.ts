function parseScheme(rawUrl: string): string {
  const match = rawUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (!match) {
    throw new Error(`Invalid MCP URL: ${rawUrl}`);
  }
  return match[1].toLowerCase();
}

function parseHost(rawUrl: string): string {
  const withoutScheme = rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split("/")[0] || "";
  const hostPort = authority.includes("@") ? authority.split("@").pop() || "" : authority;
  if (!hostPort) {
    throw new Error(`Invalid MCP URL host: ${rawUrl}`);
  }

  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end <= 1) {
      throw new Error(`Invalid MCP URL host: ${rawUrl}`);
    }
    return hostPort.slice(1, end).toLowerCase();
  }

  return hostPort.split(":")[0].toLowerCase();
}

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
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local")) {
    return true;
  }
  if (host.includes(":")) {
    return isPrivateIpv6(host);
  }
  return isPrivateIpv4(host);
}

export function validateMcpUrl(rawUrl: string, allowLocalHttp = false): string {
  const normalized = rawUrl.trim();
  const scheme = parseScheme(normalized);
  const host = parseHost(normalized);

  if (scheme !== "https" && scheme !== "http") {
    throw new Error(`Unsupported MCP URL scheme: ${scheme}:`);
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

  return normalized;
}
