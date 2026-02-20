import { EventEmitter } from "events";
import { GrokAgent } from "./grok-agent.js";
import { Repomap2 } from "./repomap.js";

export interface Task {
  id: string;
  type: "edit" | "git" | "search" | "mcp" | "reason";
  payload: Record<string, unknown>;
  priority: number;
  context?: Record<string, unknown>;
}

export interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  artifacts?: Record<string, unknown>;
}

export class AgentSupervisor extends EventEmitter {
  private workers: Map<string, GrokAgent> = new Map();
  private repomap: Repomap2;
  private activeTasks: Map<string, Task> = new Map();

  constructor(private apiKey: string) {
    super();
    this.repomap = new Repomap2();
  }

  async executeTask(task: Task): Promise<TaskResult> {
    this.activeTasks.set(task.id, task);
    this.emit("taskStarted", task);

    const query = typeof task.payload.query === "string"
      ? task.payload.query
      : JSON.stringify(task.payload);

    const relevantFiles = await this.repomap.getRelevantFiles(query, 8);
    task.context = { ...task.context, relevantFiles };

    const worker = await this.getOrCreateWorker(task.type);

    try {
      const result = await worker.processUserMessage(
        `Task type: ${task.type}\nPayload: ${JSON.stringify(task.payload)}\nContext: ${JSON.stringify(task.context)}`
      );

      const finalMessage = result[result.length - 1]?.content ?? "Task completed";
      const taskResult: TaskResult = {
        success: true,
        output: finalMessage,
      };

      this.emit("taskCompleted", { task, result: taskResult });
      return taskResult;
    } catch (error) {
      const taskResult: TaskResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit("taskFailed", { task, result: taskResult });
      return taskResult;
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  private async getOrCreateWorker(type: string): Promise<GrokAgent> {
    if (!this.workers.has(type)) {
      const worker = new GrokAgent(this.apiKey, undefined, undefined, undefined, false);
      this.workers.set(type, worker);
    }
    const worker = this.workers.get(type);
    if (!worker) {
      throw new Error(`Failed to create worker for type: ${type}`);
    }
    return worker;
  }
}
