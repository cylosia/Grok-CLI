import { spawn } from "child_process";
import { killProcessTree } from "../utils/process-tree.js";

const MAX_OUTPUT_BYTES = 1_000_000;
const GIT_TIMEOUT_MS = 30_000;

function runGit(args: string[]): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { shell: false, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let totalOutputBytes = 0;
    let truncated = false;
    let timedOut = false;

    const appendChunk = (current: string, data: unknown): string => {
      if (truncated) return current;
      const chunk = String(data);
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (totalOutputBytes + chunkBytes <= MAX_OUTPUT_BYTES) {
        totalOutputBytes += chunkBytes;
        return current + chunk;
      }
      truncated = true;
      totalOutputBytes = MAX_OUTPUT_BYTES;
      return `${current}\n[output truncated after ${MAX_OUTPUT_BYTES} bytes]`;
    };

    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid ?? 0, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killProcessTree(child.pid ?? 0, "SIGKILL");
      }, 1_500);
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      stdout = appendChunk(stdout, data);
    });

    child.stderr.on("data", (data) => {
      stderr = appendChunk(stderr, data);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut) {
        resolve({ success: false, output: "git command timed out" });
        return;
      }
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() || "OK" });
      } else {
        resolve({ success: false, output: (stderr || stdout).trim() || `git exited with code ${code}` });
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const message = error instanceof Error ? error.message : String(error);
      resolve({ success: false, output: message });
    });
  });
}

export class GitSuite {
  async createCheckpoint(name: string): Promise<string> {
    // Use -u to only stage already-tracked files; avoids accidentally committing
    // untracked secrets (.env, credentials, private keys) that .gitignore may miss.
    const add = await runGit(["add", "-u"]);
    if (!add.success) {
      return `Checkpoint failed during stage: ${add.output}`;
    }

    const commit = await runGit(["commit", "-m", `checkpoint: ${name}`]);
    return commit.success
      ? `Checkpoint "${name}" created`
      : `Checkpoint failed during commit: ${commit.output}`;
  }

  async selectiveCommit(files: string[], message: string): Promise<string> {
    if (files.length === 0) {
      return "No files specified for selective commit";
    }

    // Reject paths that look like flags to prevent argument injection
    for (const file of files) {
      if (file.startsWith("-")) {
        return `Refusing to stage path that starts with '-': ${file}`;
      }
    }

    const add = await runGit(["add", "--", ...files]);
    if (!add.success) {
      return `Selective commit failed during stage: ${add.output}`;
    }

    const commit = await runGit(["commit", "-m", message]);
    return commit.success
      ? `Committed ${files.length} file(s)`
      : `Selective commit failed during commit: ${commit.output}`;
  }
}
