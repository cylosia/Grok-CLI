import { readFileSync } from "node:fs";

const FALLBACK_VERSION = "0.0.0";

export function getCliVersion(): string {
  const envVersion = process.env.npm_package_version;
  if (typeof envVersion === "string" && envVersion.trim().length > 0) {
    return envVersion.trim();
  }

  try {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // ignore and fall back
  }

  return FALLBACK_VERSION;
}
