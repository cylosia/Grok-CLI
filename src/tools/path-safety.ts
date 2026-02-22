import fs from "fs-extra";
import path from "path";

export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveSafePathWithinRoot(root: string, filePath: string): Promise<string> {
  const workspaceRootReal = await fs.realpath(root);
  const resolvedPath = path.resolve(workspaceRootReal, filePath);

  if (!isWithinRoot(workspaceRootReal, resolvedPath)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }

  const existingTarget = await fs.pathExists(resolvedPath);
  if (existingTarget) {
    const targetReal = await fs.realpath(resolvedPath);
    if (!isWithinRoot(workspaceRootReal, targetReal)) {
      throw new Error(`Path resolves outside workspace root: ${filePath}`);
    }
    return targetReal;
  }

  let ancestor = path.dirname(resolvedPath);
  while (!(await fs.pathExists(ancestor))) {
    const next = path.dirname(ancestor);
    if (next === ancestor) {
      throw new Error(`Unable to resolve safe parent for path: ${filePath}`);
    }
    ancestor = next;
  }

  const ancestorReal = await fs.realpath(ancestor);
  if (!isWithinRoot(workspaceRootReal, ancestorReal)) {
    throw new Error(`Path parent resolves outside workspace root: ${filePath}`);
  }

  return resolvedPath;
}
