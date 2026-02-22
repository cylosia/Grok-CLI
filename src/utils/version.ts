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
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === "string" && version.trim().length > 0) {
        return version.trim();
      }
    }
  } catch {
    // ignore and fall back
  }

  return FALLBACK_VERSION;
}
