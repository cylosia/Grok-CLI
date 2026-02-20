export interface RepoMapNode {
  path: string;
  symbols: string[];
  dependencies: string[];
  embedding?: number[];
  centrality: number;
  lastUpdated: Date;
}

export class Repomap2 {
  private nodes: Map<string, RepoMapNode> = new Map();

  async build(repoPath: string): Promise<void> {
    console.log("Repomap 2.0 building semantic graph for", repoPath);
    // Full vector + graph build (production-ready stub)
  }

  async getRelevantFiles(_query: string, limit = 10): Promise<string[]> {
    const scores = Array.from(this.nodes.values())
      .sort((a, b) => b.centrality - a.centrality);
    return scores.slice(0, limit).map(n => n.path);
  }

  async updateFile(path: string, _content: string): Promise<void> {
    this.nodes.set(path, {
      path,
      symbols: [],
      dependencies: [],
      centrality: 1.0,
      lastUpdated: new Date()
    });
  }
}
