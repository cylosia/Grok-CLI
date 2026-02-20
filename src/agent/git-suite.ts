import { spawn } from "child_process";

function runGit(args: string[]): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { shell: false });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += String(data);
    });

    child.stderr.on("data", (data) => {
      stderr += String(data);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() || "OK" });
      } else {
        resolve({ success: false, output: (stderr || stdout).trim() || `git exited with code ${code}` });
      }
    });

    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ success: false, output: message });
    });
  });
}

export class GitSuite {
  async createCheckpoint(name: string): Promise<string> {
    const add = await runGit(["add", "."]);
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

    const add = await runGit(["add", ...files]);
    if (!add.success) {
      return `Selective commit failed during stage: ${add.output}`;
    }

    const commit = await runGit(["commit", "-m", message]);
    return commit.success
      ? `Committed ${files.length} file(s)`
      : `Selective commit failed during commit: ${commit.output}`;
  }
}
