import { execFile } from "child_process";

export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    execFile("taskkill", args, () => {
      // Best-effort process cleanup.
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // Fall back to direct pid kill when process group signaling is unavailable.
    try {
      process.kill(pid, signal);
    } catch {
      // Best-effort process cleanup.
    }
  }
}
