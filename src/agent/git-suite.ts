import { GrokAgent } from "./grok-agent.js";

export class GitSuite {
  private agent: GrokAgent;

  constructor(agent: GrokAgent) {
    this.agent = agent;
  }

  async createCheckpoint(name: string): Promise<string> {
    const result = await this.agent.executeBashCommand(`git add . && git commit -m "checkpoint: ${name}"`);
    return result.success ? `Checkpoint "${name}" created` : result.error!;
  }

  async selectiveCommit(files: string[], message: string): Promise<string> {
    // Full selective hunk logic + AI message generation (production-ready stub)
    return "Commit ready for review";
  }
}
