import { GrokAgent } from "./grok-agent.js";
import { ConfirmationService } from "../utils/confirmation-service.js";

export class ParallelExecutor {
  private agent: GrokAgent;
  private confirmationService: ConfirmationService;

  constructor(agent: GrokAgent) {
    this.agent = agent;
    this.confirmationService = ConfirmationService.getInstance();
  }

  async executeParallel(tasks: any[]): Promise<any[]> {
    const results = await Promise.all(
      tasks.map(async (task) => {
        const confirmed = await this.confirmationService.requestConfirmation(task.description);
        if (!confirmed) return { success: false, error: "User rejected" };
        return this.agent.delegate(task);
      })
    );
    return results;
  }
}
