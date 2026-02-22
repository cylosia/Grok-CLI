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

  async executeParallel(tasks: ParallelTask[], concurrency = 3): Promise<TaskResult[]> {
    if (tasks.length === 0) {
      return [];
    }

    const results: TaskResult[] = new Array(tasks.length);
    let cursor = 0;

    const runNext = async (): Promise<void> => {
      const index = cursor++;  // atomic read-and-increment in single expression
      if (index >= tasks.length) {
        return;
      }

      const task = tasks[index];
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
        results[index] = { success: false, error: confirmation.feedback || "User rejected" };
      } else {
        results[index] = await this.agent.delegate({ ...task, priority: 0 });
      }

      await runNext();
    };

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
    await Promise.all(workers);
    return results;
  }
}
