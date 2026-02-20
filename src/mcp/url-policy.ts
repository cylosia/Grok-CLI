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

type DnsLookup = (hostname: string, options: { all: boolean; verbatim: boolean }) => Promise<Array<{ address: string }>>;

function getNodeLookup(): DnsLookup | null {
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (!req) return null;
    const dnsModule = req("dns") as { promises?: { lookup?: DnsLookup } };
    return dnsModule.promises?.lookup || null;
  } catch {
    return null;
  }
}

async function resolveHostAddresses(host: string): Promise<string[]> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return [host];
  }

  const lookup = getNodeLookup();
  if (!lookup) {
    if (isPrivateHost(host)) {
      return [host];
    }
    throw new Error("DNS lookup unavailable in current runtime");
  }

  try {
    const results = await lookup(host, { all: true, verbatim: true });
    if (!results.length) {
      throw new Error("No DNS records returned");
    }
    return results.map((entry: { address: string }) => entry.address);
  } catch (error) {
    throw new Error(`Failed to resolve host ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function validateMcpUrl(rawUrl: string, allowLocalHttp = false): Promise<string> {
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

  const resolvedAddresses = await resolveHostAddresses(host);
  const hostIsPrivate = isPrivateHost(host) || resolvedAddresses.some((address) => isPrivateHost(address));

  if (scheme === "http") {
    if (!allowLocalHttp || !hostIsPrivate) {
      throw new Error("HTTP MCP URLs are restricted to explicitly-allowed local endpoints");
    }
  }

  if (scheme === "https" && hostIsPrivate && !allowLocalHttp) {
    throw new Error("Private-network MCP URLs require explicit local-network opt-in");
  }

  return parsed.toString();
}
