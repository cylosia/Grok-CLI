import { GrokAgent } from "./grok-agent.js";
import { ConfirmationService } from "../utils/confirmation-service.js";
import { TaskResult } from "./supervisor.js";

interface ParallelTask {
  id: string;
  type: "edit" | "git" | "search" | "mcp" | "reason";
  payload: Record<string, unknown>;
  description?: string;
}

export class ParallelExecutor {
  private confirmationService: ConfirmationService;

  constructor(private agent: GrokAgent) {
    this.confirmationService = ConfirmationService.getInstance();
  }

  async executeParallel(tasks: ParallelTask[]): Promise<TaskResult[]> {
    const results = await Promise.all(
      tasks.map(async (task) => {
        const confirmation = await this.confirmationService.requestConfirmation(
          {
            operation: `Execute ${task.type} task`,
            filename: task.id,
            content: task.description || JSON.stringify(task.payload),
            showVSCodeOpen: false,
          },
          "file"
        );

        if (!confirmation.confirmed) {
          return { success: false, error: confirmation.feedback || "User rejected" };
        }

        return this.agent.delegate({ ...task, priority: 0 });
      })
    );

    return results;
  }
}
