import fs from "fs-extra";
import { constants as fsConstants } from "fs";
import { open as openFile } from "fs/promises";
import axios from "axios";
import { ToolResult } from "../types/index.js";
import { ConfirmationService } from "../utils/confirmation-service.js";
import { resolveSafePathWithinRoot } from "./path-safety.js";

export class MorphEditorTool {
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
      console.warn("MORPH_API_KEY not found. Morph editor functionality will be limited.");
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

      // Call Morph Fast Apply API
      const mergedCode = await this.callMorphApply(instructions, initialCode, codeEdit);

      // Write the merged code back to file (symlink-safe)
      await this.ensureNotSymlink(resolvedPath);
      await this.writeFileNoFollow(resolvedPath, mergedCode);

      // Generate diff for display
      const oldLines = initialCode.split("\n");
      const newLines = mergedCode.split("\n");
      const diff = this.generateDiff(oldLines, newLines, targetFile);

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
      });

      if (!response.data.choices || !response.data.choices[0] || !response.data.choices[0].message) {
        throw new Error("Invalid response format from Morph API");
      }

      return response.data.choices[0].message.content;
    } catch (error: unknown) {
      const maybeError = error as { response?: { status?: number } };
      if (maybeError.response) {
        const status = maybeError.response.status ?? 'unknown';
        throw new Error(`Morph API error (${status})`);
      }
      throw (error instanceof Error ? error : new Error(String(error)));
    }
  }

  private generateDiff(
    oldLines: string[],
    newLines: string[],
    filePath: string
  ): string {
    const CONTEXT_LINES = 3;
    
    const changes: Array<{
      oldStart: number;
      oldEnd: number;
      newStart: number;
      newEnd: number;
    }> = [];
    
    let i = 0, j = 0;
    
    while (i < oldLines.length || j < newLines.length) {
      while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        i++;
        j++;
      }
      
      if (i < oldLines.length || j < newLines.length) {
        const changeStart = { old: i, new: j };
        
        let oldEnd = i;
        let newEnd = j;
        
        while (oldEnd < oldLines.length || newEnd < newLines.length) {
          let matchFound = false;
          let matchLength = 0;
          
          for (let k = 0; k < Math.min(2, oldLines.length - oldEnd, newLines.length - newEnd); k++) {
            if (oldEnd + k < oldLines.length && 
                newEnd + k < newLines.length && 
                oldLines[oldEnd + k] === newLines[newEnd + k]) {
              matchLength++;
            } else {
              break;
            }
          }
          
          if (matchLength >= 2 || (oldEnd >= oldLines.length && newEnd >= newLines.length)) {
            matchFound = true;
          }
          
          if (matchFound) {
            break;
          }
          
          if (oldEnd < oldLines.length) oldEnd++;
          if (newEnd < newLines.length) newEnd++;
        }
        
        changes.push({
          oldStart: changeStart.old,
          oldEnd: oldEnd,
          newStart: changeStart.new,
          newEnd: newEnd
        });
        
        i = oldEnd;
        j = newEnd;
      }
    }
    
    const hunks: Array<{
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      lines: Array<{ type: '+' | '-' | ' '; content: string }>;
    }> = [];
    
    let accumulatedOffset = 0;
    
    for (let changeIdx = 0; changeIdx < changes.length; changeIdx++) {
      const change = changes[changeIdx];
      
      let contextStart = Math.max(0, change.oldStart - CONTEXT_LINES);
      let contextEnd = Math.min(oldLines.length, change.oldEnd + CONTEXT_LINES);
      
      if (hunks.length > 0) {
        const lastHunk = hunks[hunks.length - 1];
        const lastHunkEnd = lastHunk.oldStart + lastHunk.oldCount;
        
        if (lastHunkEnd >= contextStart) {
          const oldHunkEnd = lastHunk.oldStart + lastHunk.oldCount;
          const newContextEnd = Math.min(oldLines.length, change.oldEnd + CONTEXT_LINES);
          
          for (let idx = oldHunkEnd; idx < change.oldStart; idx++) {
            lastHunk.lines.push({ type: ' ', content: oldLines[idx] });
          }
          
          for (let idx = change.oldStart; idx < change.oldEnd; idx++) {
            lastHunk.lines.push({ type: '-', content: oldLines[idx] });
          }
          for (let idx = change.newStart; idx < change.newEnd; idx++) {
            lastHunk.lines.push({ type: '+', content: newLines[idx] });
          }
          
          for (let idx = change.oldEnd; idx < newContextEnd && idx < oldLines.length; idx++) {
            lastHunk.lines.push({ type: ' ', content: oldLines[idx] });
          }
          
          lastHunk.oldCount = newContextEnd - lastHunk.oldStart;
          lastHunk.newCount = lastHunk.oldCount + (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart);
          
          continue;
        }
      }
      
      const hunk: typeof hunks[0] = {
        oldStart: contextStart + 1,
        oldCount: contextEnd - contextStart,
        newStart: contextStart + 1 + accumulatedOffset,
        newCount: contextEnd - contextStart + (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart),
        lines: []
      };
      
      for (let idx = contextStart; idx < change.oldStart; idx++) {
        hunk.lines.push({ type: ' ', content: oldLines[idx] });
      }
      
      for (let idx = change.oldStart; idx < change.oldEnd; idx++) {
        hunk.lines.push({ type: '-', content: oldLines[idx] });
      }
      
      for (let idx = change.newStart; idx < change.newEnd; idx++) {
        hunk.lines.push({ type: '+', content: newLines[idx] });
      }
      
      for (let idx = change.oldEnd; idx < contextEnd && idx < oldLines.length; idx++) {
        hunk.lines.push({ type: ' ', content: oldLines[idx] });
      }
      
      hunks.push(hunk);
      
      accumulatedOffset += (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart);
    }
    
    let addedLines = 0;
    let removedLines = 0;
    
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type === '+') addedLines++;
        if (line.type === '-') removedLines++;
      }
    }
    
    let summary = `Updated ${filePath} with Morph Fast Apply`;
    if (addedLines > 0 && removedLines > 0) {
      summary += ` - ${addedLines} addition${
        addedLines !== 1 ? "s" : ""
      } and ${removedLines} removal${removedLines !== 1 ? "s" : ""}`;
    } else if (addedLines > 0) {
      summary += ` - ${addedLines} addition${addedLines !== 1 ? "s" : ""}`;
    } else if (removedLines > 0) {
      summary += ` - ${removedLines} removal${
        removedLines !== 1 ? "s" : ""
      }`;
    } else if (changes.length === 0) {
      return `No changes applied to ${filePath}`;
    }
    
    let diff = summary + "\n";
    diff += `--- a/${filePath}\n`;
    diff += `+++ b/${filePath}\n`;
    
    for (const hunk of hunks) {
      diff += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
      
      for (const line of hunk.lines) {
        diff += `${line.type}${line.content}\n`;
      }
    }
    
    return diff.trim();
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

  getApiKey(): string {
    return this.morphApiKey;
  }
}
