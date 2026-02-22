import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DNS_LOOKUP_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const segment of parts) {
    // Reject non-decimal representations (hex, octal, empty, whitespace)
    if (!/^\d{1,3}$/.test(segment)) {
      return null;
    }
    const value = Number(segment);
    if (value < 0 || value > 255) {
      return null;
    }
    nums.push(value);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4(host);
  if (!parts) {
    return false;
  }

  const [a, b, c] = parts;
  if (a === 0) return true;                            // 0.0.0.0/8   (current network)
  if (a === 10 || a === 127) return true;              // 10.0.0.0/8, 127.0.0.0/8
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT / shared)
  if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true;    // 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true;  // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true;                           // 224.0.0.0+ (multicast + reserved + broadcast)
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1" || normalized === "::") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    return isPrivateIpv4(mappedIpv4);
  }

  return normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
    || normalized.startsWith("fec0:")
    || normalized.startsWith("2001:db8:")  // Documentation range (RFC 3849)
    || normalized.startsWith("100::");      // Discard prefix (RFC 6666)
}

function isPrivateIpv6Unscoped(host: string): boolean {
  const withoutZone = host.includes("%") ? host.slice(0, host.indexOf("%")) : host;
  return isPrivateIpv6(withoutZone);
}

function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.+$/, "");
  if (normalized === "localhost" || normalized.endsWith(".local") || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized.includes(":")) {
    return isPrivateIpv6Unscoped(normalized);
  }
  return isPrivateIpv4(normalized);
}

async function resolveHostAddresses(host: string): Promise<string[]> {
  if (isIP(host) !== 0) {
    return [host];
  }

  try {
    const results = await withTimeout(
      lookup(host, { all: true, verbatim: true }),
      DNS_LOOKUP_TIMEOUT_MS,
      `DNS lookup timed out for host ${host} after ${DNS_LOOKUP_TIMEOUT_MS}ms`
    );
    if (!results.length) {
      throw new Error("No DNS records returned");
    }
    return results.map((entry: { address: string }) => entry.address);
  } catch (error) {
    throw new Error(`Failed to resolve host ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveStableHostAddresses(host: string): Promise<string[]> {
  const first = await resolveHostAddresses(host);
  if (isIP(host) !== 0) {
    return first;
  }

  const second = await resolveHostAddresses(host);
  const normalize = (values: string[]) => [...new Set(values)].sort();
  const a = normalize(first);
  const b = normalize(second);
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
    throw new Error(`DNS resolution changed during MCP URL validation for host ${host}; refusing to connect`);
  }
  return a;
}

export interface McpUrlValidationOptions {
  allowLocalHttp?: boolean;
  allowPrivateHttps?: boolean;
  pinnedAddresses?: string[];
}

function normalizeAddresses(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function assertPinnedAddresses(host: string, resolvedAddresses: string[], pinnedAddresses: string[]): void {
  const resolved = normalizeAddresses(resolvedAddresses);
  const pinned = normalizeAddresses(pinnedAddresses);
  if (resolved.length !== pinned.length || resolved.some((value, index) => value !== pinned[index])) {
    throw new Error(`Resolved addresses for ${host} do not match pinned MCP endpoint addresses`);
  }
}

export async function validateMcpUrl(rawUrl: string, options: McpUrlValidationOptions = {}): Promise<string> {
  const allowLocalHttp = options.allowLocalHttp ?? false;
  const allowPrivateHttps = options.allowPrivateHttps ?? false;
  const pinnedAddresses = options.pinnedAddresses;
  const normalized = rawUrl.trim();

  const URLCtor = (globalThis as { URL?: new (input: string) => { protocol: string; hostname: string; username: string; password: string; toString(): string } }).URL;
  if (!URLCtor) {
    throw new Error("URL parser is not available in this runtime");
  }

  let parsed: { protocol: string; hostname: string; username: string; password: string; toString(): string };
  try {
    parsed = new URLCtor(normalized);
  } catch {
    throw new Error(`Invalid MCP URL: ${rawUrl}`);
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    throw new Error(`Unsupported MCP URL scheme: ${scheme}:`);
  }


  if (parsed.username || parsed.password) {
    throw new Error("MCP URLs must not include URL credentials");
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new Error(`Invalid MCP URL host: ${rawUrl}`);
  }

  const resolvedAddresses = await resolveStableHostAddresses(host);
  if (Array.isArray(pinnedAddresses) && pinnedAddresses.length > 0) {
    assertPinnedAddresses(host, resolvedAddresses, pinnedAddresses);
  }
  const hostIsPrivate = isPrivateHost(host) || resolvedAddresses.some((address) => isPrivateHost(address));

  if (scheme === "http") {
    if (!allowLocalHttp || !hostIsPrivate) {
      throw new Error("HTTP MCP URLs are restricted to explicitly-allowed local endpoints");
    }
  }

  if (scheme === "https" && hostIsPrivate && !allowPrivateHttps) {
    throw new Error("Private-network MCP URLs require explicit local-network opt-in");
  }

  return parsed.toString();
}
