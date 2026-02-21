import fs from "fs-extra";
import * as path from "path";
import { constants as fsConstants } from "fs";
import { open as openFile } from "fs/promises";
import { ToolResult, EditorCommand } from "../types/index.js";
import { ConfirmationService } from "../utils/confirmation-service.js";
import { generateUnifiedDiff } from "./diff-utils.js";
import { resolveSafePathWithinRoot } from "./path-safety.js";

export class TextEditorTool {
  private editHistory: EditorCommand[] = [];
  private confirmationService = ConfirmationService.getInstance();
  private workspaceRoot = process.cwd();


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

  private async createFileNoFollow(targetPath: string, content: string): Promise<void> {
    const handle = await openFile(targetPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content, { encoding: "utf-8" });
    } finally {
      await handle.close();
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

  async strReplace(
    filePath: string,
    oldStr: string,
    newStr: string,
    replaceAll: boolean = false
  ): Promise<ToolResult> {
    try {
      const resolvedPath = await this.resolveSafePath(filePath);

      if (!(await fs.pathExists(resolvedPath))) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      const content = await fs.readFile(resolvedPath, "utf-8");

      if (!content.includes(oldStr)) {
        if (oldStr.includes('\n')) {
          const fuzzyResult = this.findFuzzyMatch(content, oldStr);
          if (fuzzyResult) {
            oldStr = fuzzyResult;
          } else {
            return {
              success: false,
              error: `String not found in file. For multi-line replacements, consider using line-based editing.`,
            };
          }
        } else {
          return {
            success: false,
            error: `String not found in file: "${oldStr}"`,
          };
        }
      }

      const occurrences = (content.match(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      
      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.fileOperations && !sessionFlags.allOperations) {
        const previewContent = replaceAll 
          ? content.split(oldStr).join(newStr)
          : content.replace(oldStr, newStr);
        const oldLines = content.split("\n");
        const newLines = previewContent.split("\n");
        const diffContent = generateUnifiedDiff(oldLines, newLines, filePath);

        const confirmationResult =
          await this.confirmationService.requestConfirmation(
            {
              operation: `Edit file${replaceAll && occurrences > 1 ? ` (${occurrences} occurrences)` : ''}`,
              filename: filePath,
              showVSCodeOpen: false,
              content: diffContent,
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

      const newContent = replaceAll
        ? content.split(oldStr).join(newStr)
        : content.replace(oldStr, newStr);
      await this.ensureNotSymlink(resolvedPath);
      await this.writeFileNoFollow(resolvedPath, newContent);

      this.editHistory.push({
        command: "str_replace",
        path: resolvedPath,
        old_str: oldStr,
        new_str: newStr,
        previous_content: content,
      });

      const oldLines = content.split("\n");
      const newLines = newContent.split("\n");
      const diff = generateUnifiedDiff(oldLines, newLines, filePath);

      return {
        success: true,
        output: diff,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Error replacing text in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async create(filePath: string, content: string): Promise<ToolResult> {
    try {
      const resolvedPath = await this.resolveSafePath(filePath);

      // Check if user has already accepted file operations for this session
      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.fileOperations && !sessionFlags.allOperations) {
        // Create a diff-style preview for file creation
        const contentLines = content.split("\n");
        const diffContent = [
          `Created ${filePath}`,
          `--- /dev/null`,
          `+++ b/${filePath}`,
          `@@ -0,0 +1,${contentLines.length} @@`,
          ...contentLines.map((line) => `+${line}`),
        ].join("\n");

        const confirmationResult =
          await this.confirmationService.requestConfirmation(
            {
              operation: "Write",
              filename: filePath,
              showVSCodeOpen: false,
              content: diffContent,
            },
            "file"
          );

        if (!confirmationResult.confirmed) {
          return {
            success: false,
            error:
              confirmationResult.feedback || "File creation cancelled by user",
          };
        }
      }

      const dir = path.dirname(resolvedPath);
      await fs.ensureDir(dir);
      await this.createFileNoFollow(resolvedPath, content);

      this.editHistory.push({
        command: "create",
        path: resolvedPath,
        content,
      });

      // Generate diff output using the same method as str_replace
      const oldLines: string[] = []; // Empty for new files
      const newLines = content.split("\n");
      const diff = generateUnifiedDiff(oldLines, newLines, filePath);

      return {
        success: true,
        output: diff,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Error creating ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async replaceLines(
    filePath: string,
    startLine: number,
    endLine: number,
    newContent: string
  ): Promise<ToolResult> {
    try {
      const resolvedPath = await this.resolveSafePath(filePath);

      if (!(await fs.pathExists(resolvedPath))) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      const fileContent = await fs.readFile(resolvedPath, "utf-8");
      const lines = fileContent.split("\n");
      
      if (startLine < 1 || startLine > lines.length) {
        return {
          success: false,
          error: `Invalid start line: ${startLine}. File has ${lines.length} lines.`,
        };
      }
      
      if (endLine < startLine || endLine > lines.length) {
        return {
          success: false,
          error: `Invalid end line: ${endLine}. Must be between ${startLine} and ${lines.length}.`,
        };
      }

      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.fileOperations && !sessionFlags.allOperations) {
        const newLines = [...lines];
        const replacementLines = newContent.split("\n");
        newLines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
        
        const diffContent = generateUnifiedDiff(lines, newLines, filePath);

        const confirmationResult =
          await this.confirmationService.requestConfirmation(
            {
              operation: `Replace lines ${startLine}-${endLine}`,
              filename: filePath,
              showVSCodeOpen: false,
              content: diffContent,
            },
            "file"
          );

        if (!confirmationResult.confirmed) {
          return {
            success: false,
            error: confirmationResult.feedback || "Line replacement cancelled by user",
          };
        }
      }

      const replacementLines = newContent.split("\n");
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
      const newFileContent = lines.join("\n");

      await this.ensureNotSymlink(resolvedPath);
      await this.writeFileNoFollow(resolvedPath, newFileContent);

      this.editHistory.push({
        command: "str_replace",
        path: resolvedPath,
        old_str: `lines ${startLine}-${endLine}`,
        new_str: newContent,
        previous_content: fileContent,
      });

      const oldLines = fileContent.split("\n");
      const diff = generateUnifiedDiff(oldLines, lines, filePath);

      return {
        success: true,
        output: diff,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Error replacing lines in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async insert(
    filePath: string,
    insertLine: number,
    content: string
  ): Promise<ToolResult> {
    try {
      const resolvedPath = await this.resolveSafePath(filePath);

      if (!(await fs.pathExists(resolvedPath))) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      const fileContent = await fs.readFile(resolvedPath, "utf-8");
      const lines = fileContent.split("\n");

      if (insertLine < 1 || insertLine > lines.length + 1) {
        return {
          success: false,
          error: `Invalid insert line: ${insertLine}. Must be between 1 and ${lines.length + 1}.`,
        };
      }

      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.fileOperations && !sessionFlags.allOperations) {
        const previewLines = [...lines];
        previewLines.splice(insertLine - 1, 0, content);
        const diffContent = generateUnifiedDiff(lines, previewLines, filePath);
        const confirmationResult = await this.confirmationService.requestConfirmation(
          {
            operation: `Insert content at line ${insertLine}`,
            filename: filePath,
            showVSCodeOpen: false,
            content: diffContent,
          },
          "file"
        );

        if (!confirmationResult.confirmed) {
          return {
            success: false,
            error: confirmationResult.feedback || "Insert cancelled by user",
          };
        }
      }

      lines.splice(insertLine - 1, 0, content);
      const newContent = lines.join("\n");

      await this.ensureNotSymlink(resolvedPath);
      await this.writeFileNoFollow(resolvedPath, newContent);

      this.editHistory.push({
        command: "insert",
        path: resolvedPath,
        insert_line: insertLine,
        content,
        previous_content: fileContent,
      });

      return {
        success: true,
        output: `Successfully inserted content at line ${insertLine} in ${filePath}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Error inserting content in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async undoEdit(): Promise<ToolResult> {
    if (this.editHistory.length === 0) {
      return {
        success: false,
        error: "No edits to undo",
      };
    }

    const lastEdit = this.editHistory.pop();
    if (!lastEdit) {
      return {
        success: false,
        error: "No edits to undo",
      };
    }

    try {
      switch (lastEdit.command) {
        case "str_replace":
          if (lastEdit.path) {
            const safePath = await this.resolveSafePath(lastEdit.path);
            if (typeof lastEdit.previous_content === "string") {
              await this.ensureNotSymlink(safePath);
              await this.writeFileNoFollow(safePath, lastEdit.previous_content);
            } else if (lastEdit.old_str && lastEdit.new_str) {
              const content = await fs.readFile(safePath, "utf-8");
              const revertedContent = content.replace(lastEdit.new_str, lastEdit.old_str);
              await this.ensureNotSymlink(safePath);
              await this.writeFileNoFollow(safePath, revertedContent);
            }
          }
          break;

        case "create":
          if (lastEdit.path) {
            const safePath = await this.resolveSafePath(lastEdit.path);
            await this.ensureNotSymlink(safePath);
            await fs.remove(safePath);
          }
          break;

        case "insert":
          if (lastEdit.path) {
            const safePath = await this.resolveSafePath(lastEdit.path);
            if (typeof lastEdit.previous_content === "string") {
              await this.ensureNotSymlink(safePath);
              await this.writeFileNoFollow(safePath, lastEdit.previous_content);
            } else if (lastEdit.insert_line) {
              const content = await fs.readFile(safePath, "utf-8");
              const lines = content.split("\n");
              lines.splice(lastEdit.insert_line - 1, 1);
              await this.ensureNotSymlink(safePath);
              await this.writeFileNoFollow(safePath, lines.join("\n"));
            }
          }
          break;
        case "view":
        case "undo_edit":
          break;
      }

      return {
        success: true,
        output: `Successfully undid ${lastEdit.command} operation`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Error undoing edit: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private findFuzzyMatch(content: string, searchStr: string): string | null {
    const functionMatch = searchStr.match(/function\s+(\w+)/);
    if (!functionMatch) return null;
    
    const functionName = functionMatch[1];
    const contentLines = content.split('\n');
    
    let functionStart = -1;
    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].includes(`function ${functionName}`) && contentLines[i].includes('{')) {
        functionStart = i;
        break;
      }
    }
    
    if (functionStart === -1) return null;
    
    let braceCount = 0;
    let functionEnd = functionStart;
    
    for (let i = functionStart; i < contentLines.length; i++) {
      const line = contentLines[i];
      for (const char of line) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
      }
      
      if (braceCount === 0 && i > functionStart) {
        functionEnd = i;
        break;
      }
    }
    
    const actualFunction = contentLines.slice(functionStart, functionEnd + 1).join('\n');
    
    const searchNormalized = this.normalizeForComparison(searchStr);
    const actualNormalized = this.normalizeForComparison(actualFunction);
    
    if (this.isSimilarStructure(searchNormalized, actualNormalized)) {
      return actualFunction;
    }
    
    return null;
  }
  
  private normalizeForComparison(str: string): string {
    return str
      .replace(/["'`]/g, '"')
      .replace(/\s+/g, ' ')
      .replace(/{\s+/g, '{ ')
      .replace(/\s+}/g, ' }')
      .replace(/;\s*/g, ';')
      .trim();
  }
  
  private isSimilarStructure(search: string, actual: string): boolean {
    const extractTokens = (str: string) => {
      const tokens = str.match(/\b(function|console\.log|return|if|else|for|while)\b/g) || [];
      return tokens;
    };

    const searchTokens = extractTokens(search);
    const actualTokens = extractTokens(actual);

    if (searchTokens.length !== actualTokens.length) return false;

    for (let i = 0; i < searchTokens.length; i++) {
      if (searchTokens[i] !== actualTokens[i]) return false;
    }

    return true;
  }


  private async resolveSafePath(filePath: string): Promise<string> {
    return resolveSafePathWithinRoot(this.workspaceRoot, filePath);
  }

  getEditHistory(): EditorCommand[] {
    return [...this.editHistory];
  }
}
