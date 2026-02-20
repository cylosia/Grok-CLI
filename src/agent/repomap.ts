import fs from "fs-extra";
import path from "path";

export interface RepoMapNode {
  path: string;
  symbols: string[];
  dependencies: string[];
  embedding?: number[];
  centrality: number;
  lastUpdated: Date;
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", ".cache"]);

function fileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

export class Repomap2 {
  private nodes: Map<string, RepoMapNode> = new Map();

  async build(repoPath: string): Promise<void> {
    this.nodes.clear();
    const files = await this.walk(repoPath);

    const uniqueDependencies = new Map<string, number>();
    for (const filePath of files) {
      const ext = fileExtension(filePath);
      const centrality = ext === ".ts" || ext === ".tsx" ? 1 : 0.5;
      const dependencies = filePath.includes("/") ? [filePath.split("/")[0]] : [];
      for (const dep of dependencies) {
        uniqueDependencies.set(dep, (uniqueDependencies.get(dep) ?? 0) + 1);
      }

      this.nodes.set(filePath, {
        path: filePath,
        symbols: [],
        dependencies,
        centrality,
        lastUpdated: new Date(),
      });
    }

    for (const node of this.nodes.values()) {
      const dependencyScore = node.dependencies.reduce((sum, dep) => sum + (uniqueDependencies.get(dep) ?? 0), 0);
      node.centrality += dependencyScore / Math.max(files.length, 1);
    }
  }

  async getRelevantFiles(_query: string, limit = 10): Promise<string[]> {
    const scores = Array.from(this.nodes.values())
      .sort((a, b) => b.centrality - a.centrality);
    return scores.slice(0, limit).map((n) => n.path);
  }

  async updateFile(filePath: string, _content: string): Promise<void> {
    this.nodes.set(filePath, {
      path: filePath,
      symbols: [],
      dependencies: [],
      centrality: 1.0,
      lastUpdated: new Date(),
    });
  }

  private async walk(root: string): Promise<string[]> {
    const files: string[] = [];

    const recurse = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) {
            await recurse(fullPath);
          }
          continue;
        }

        if (entry.isFile()) {
          const relative = fullPath.startsWith(`${root}/`) ? fullPath.slice(root.length + 1) : fullPath;
          files.push(relative);
        }
      }
    };

    await recurse(root);
    return files;
  }
}
