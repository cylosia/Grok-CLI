import fs from "fs-extra";
import { constants as fsConstants } from "fs";
import { open as openFile } from "fs/promises";
import axios from "axios";
import { ToolResult } from "../types/index.js";
import { ConfirmationService } from "../utils/confirmation-service.js";
import { resolveSafePathWithinRoot } from "./path-safety.js";
import { generateUnifiedDiff } from "./diff-utils.js";
import { logger } from "../utils/logger.js";

export class MorphEditorTool {
  private static readonly MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
  private confirmationService = ConfirmationService.getInstance();
  private morphApiKey: string;
  private morphBaseUrl: string = "https://api.morphllm.com/v1";
  private workspaceRoot = process.cwd();
  private static readonly SENSITIVE_PATTERNS = [
    /(?:^|\/)\.env(?:\.|$)/i,
    /(?:^|\/)id_rsa(?:\.pub)?$/i,
    /(?:^|\/)id_ed25519(?:\.pub)?$/i,
    /(?:^|\/)secrets?\b/i,
    /(?:^|\/)credentials?\b/i,
    /(?:^|\/)\.ssh\//i,
  ];

  constructor(apiKey?: string) {
    this.morphApiKey = apiKey || process.env.MORPH_API_KEY || "";
    if (!this.morphApiKey) {
      logger.warn("morph-api-key-missing", { component: "morph-editor" });
    }
  }

  /**
   * Use this tool to make an edit to an existing file.
   * 
   * This will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.
   * When writing the edit, you should specify each edit in sequence, with the special comment // ... existing code ... to represent unchanged code in between edited lines.
   * 
   * For example:
   * 
   * // ... existing code ...
   * FIRST_EDIT
   * // ... existing code ...
   * SECOND_EDIT
   * // ... existing code ...
   * THIRD_EDIT
   * // ... existing code ...
   * 
   * You should still bias towards repeating as few lines of the original file as possible to convey the change.
   * But, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.
   * DO NOT omit spans of pre-existing code (or comments) without using the // ... existing code ... comment to indicate its absence. If you omit the existing code comment, the model may inadvertently delete these lines.
   * If you plan on deleting a section, you must provide context before and after to delete it. If the initial code is ```code \n Block 1 \n Block 2 \n Block 3 \n code```, and you want to remove Block 2, you would output ```// ... existing code ... \n Block 1 \n  Block 3 \n // ... existing code ...```.
   * Make sure it is clear what the edit should be, and where it should be applied.
   * Make edits to a file in a single edit_file call instead of multiple edit_file calls to the same file. The apply model can handle many distinct edits at once.
   */
  async editFile(
    targetFile: string,
    instructions: string,
    codeEdit: string
  ): Promise<ToolResult> {
    try {
      const resolvedPath = await this.resolveSafePath(targetFile);

      if (!(await fs.pathExists(resolvedPath))) {
        return {
          success: false,
          error: `File not found: ${targetFile}`,
        };
      }

      const fileStat = await fs.stat(resolvedPath);
      if (fileStat.size > MorphEditorTool.MAX_FILE_SIZE_BYTES) {
        return {
          success: false,
          error: `File too large (${fileStat.size} bytes, max ${MorphEditorTool.MAX_FILE_SIZE_BYTES}). Use str_replace_editor for large files.`,
        };
      }

      if (!this.morphApiKey) {
        return {
          success: false,
          error: "MORPH_API_KEY not configured. Please set your Morph API key.",
        };
      }

      // Read the initial code
      const initialCode = await fs.readFile(resolvedPath, "utf-8");
      if (this.containsSensitiveMaterial(targetFile, initialCode)) {
        return {
          success: false,
          error: "Refusing to send potentially sensitive file content to external API",
        };
      }

      // Check user confirmation before proceeding
      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.fileOperations && !sessionFlags.allOperations) {
        const confirmationResult = await this.confirmationService.requestConfirmation(
          {
            operation: "Edit file with Morph Fast Apply",
            filename: targetFile,
            showVSCodeOpen: false,
            content: `Instructions: ${instructions}\n\nEdit:\n${codeEdit}`,
          },
          "file"
        );

        if (!confirmationResult.confirmed) {
          return {
            success: false,
            error: confirmationResult.feedback || "File edit cancelled by user",
          };
        }
      }

      // Re-read the file after confirmation to detect external modifications
      // and re-check for sensitive content before sending to external API.
      const currentContent = await fs.readFile(resolvedPath, "utf-8");
      if (currentContent !== initialCode) {
        return {
          success: false,
          error: "File was modified externally during confirmation; aborting to prevent data loss.",
        };
      }
      if (this.containsSensitiveMaterial(targetFile, currentContent)) {
        return {
          success: false,
          error: "File now contains sensitive content; aborting external API call.",
        };
      }

      // Call Morph Fast Apply API
      const mergedCode = await this.callMorphApply(instructions, currentContent, codeEdit);

      // Write the merged code back to file (symlink-safe)
      await this.ensureNotSymlink(resolvedPath);
      await this.writeFileNoFollow(resolvedPath, mergedCode);

      // Generate diff for display
      const oldLines = initialCode.split("\n");
      const newLines = mergedCode.split("\n");
      const diff = generateUnifiedDiff(oldLines, newLines, targetFile);

      return {
        success: true,
        output: diff,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Error editing ${targetFile} with Morph: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private containsSensitiveMaterial(filePath: string, content: string): boolean {
    if (MorphEditorTool.SENSITIVE_PATTERNS.some((pattern) => pattern.test(filePath))) {
      return true;
    }

    const secretLikePatterns = [
      /BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY/i,
      /(?:api[_-]?key|token|password|secret)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{12,}/i,
    ];
    return secretLikePatterns.some((pattern) => pattern.test(content));
  }

  private async callMorphApply(
    instructions: string,
    initialCode: string,
    editSnippet: string
  ): Promise<string> {
    try {
      const response = await axios.post(`${this.morphBaseUrl}/chat/completions`, {
        model: "morph-v3-large",
        messages: [
          {
            role: "user",
            content: `<instruction>${instructions}</instruction>\n<code>${initialCode}</code>\n<update>${editSnippet}</update>`,
          },
        ],
      }, {
        headers: {
          "Authorization": `Bearer ${this.morphApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      });

      if (!response.data.choices || !response.data.choices[0] || !response.data.choices[0].message) {
        throw new Error("Invalid response format from Morph API");
      }

      const content = response.data.choices[0].message.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("Morph API returned empty or non-string content");
      }
      return content;
    } catch (error: unknown) {
      const maybeError = error as { response?: { status?: number } };
      if (maybeError.response) {
        const status = maybeError.response.status ?? 'unknown';
        throw new Error(`Morph API error (${status})`);
      }
      throw (error instanceof Error ? error : new Error(String(error)));
    }
  }

  async view(
    filePath: string,
    viewRange?: [number, number]
  ): Promise<ToolResult> {
    try {
      const resolvedPath = await this.resolveSafePath(filePath);

      if (await fs.pathExists(resolvedPath)) {
        const stats = await fs.stat(resolvedPath);

        if (stats.isDirectory()) {
          const files = await fs.readdir(resolvedPath);
          return {
            success: true,
            output: `Directory contents of ${filePath}:\n${files.join("\n")}`,
          };
        }

        const content = await fs.readFile(resolvedPath, "utf-8");
        const lines = content.split("\n");

        if (viewRange) {
          const [start, end] = viewRange;
          const selectedLines = lines.slice(start - 1, end);
          const numberedLines = selectedLines
            .map((line: string, idx: number) => `${start + idx}: ${line}`)
            .join("\n");

          return {
            success: true,
            output: `Lines ${start}-${end} of ${filePath}:\n${numberedLines}`,
          };
        }

        const totalLines = lines.length;
        const displayLines = totalLines > 10 ? lines.slice(0, 10) : lines;
        const numberedLines = displayLines
          .map((line: string, idx: number) => `${idx + 1}: ${line}`)
          .join("\n");
        const additionalLinesMessage =
          totalLines > 10 ? `\n... +${totalLines - 10} lines` : "";

        return {
          success: true,
          output: `Contents of ${filePath}:\n${numberedLines}${additionalLinesMessage}`,
        };
      } else {
        return {
          success: false,
          error: `File or directory not found: ${filePath}`,
        };
      }
    } catch (error: unknown) {
      return {
        success: false,
        error: `Error viewing ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }


  private async ensureNotSymlink(targetPath: string): Promise<void> {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${targetPath}`);
    }
  }

  private async writeFileNoFollow(targetPath: string, content: string): Promise<void> {
    const handle = await openFile(targetPath, fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
    try {
      await handle.writeFile(content, { encoding: "utf-8" });
    } finally {
      await handle.close();
    }
  }

  private async resolveSafePath(filePath: string): Promise<string> {
    return resolveSafePathWithinRoot(this.workspaceRoot, filePath);
  }

  setApiKey(apiKey: string): void {
    this.morphApiKey = apiKey;
  }

  hasApiKey(): boolean {
    return this.morphApiKey.length > 0;
  }
}
