import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".").map((segment) => Number(segment));
  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return null;
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4(host);
  if (!parts) {
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
  if (normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    return isPrivateIpv4(mappedIpv4);
  }

  return normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
    || normalized.startsWith("fec0:");
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

async function resolveHostAddresses(host: string): Promise<string[]> {
  if (isIP(host) !== 0) {
    return [host];
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

  const resolvedAddresses = await resolveStableHostAddresses(host);
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
