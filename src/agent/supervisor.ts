import { TaskId, parseTaskId } from "../types/index.js";
import { EventEmitter } from "events";
import { GrokAgent } from "./grok-agent.js";
import { Repomap2 } from "./repomap.js";

function redactForPrompt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactForPrompt(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (/(api[-_]?key|token|password|secret|authorization|cookie)/i.test(key)) {
          return [key, "[REDACTED]"];
        }
        return [key, redactForPrompt(child)];
      })
    );
  }

  return value;
}

export interface Task {
  id: TaskId;
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
  private workers: Map<Task["type"], GrokAgent> = new Map();
  private repomap: Repomap2;
  private activeTasks: Map<TaskId, Task> = new Map();

  constructor(private apiKey: string) {
    super();
    this.repomap = new Repomap2();
  }

  async executeTask(task: Task): Promise<TaskResult> {
    if (!parseTaskId(String(task.id))) {
      return { success: false, error: `Invalid task id: ${String(task.id)}` };
    }

    const taskSnapshot: Task = {
      ...task,
      payload: { ...task.payload },
      ...(task.context ? { context: { ...task.context } } : {}),
    };

    this.activeTasks.set(task.id, taskSnapshot);
    this.emit("taskStarted", taskSnapshot);

    const query = typeof taskSnapshot.payload.query === "string"
      ? taskSnapshot.payload.query
      : JSON.stringify(taskSnapshot.payload);

    const relevantFiles = await this.repomap.getRelevantFiles(query, 8);
    const executionContext = { ...taskSnapshot.context, relevantFiles };

    const worker = await this.getOrCreateWorker(taskSnapshot.type);

    try {
      const redactedPayload = redactForPrompt(taskSnapshot.payload);
      const redactedContext = redactForPrompt(executionContext);
      const result = await worker.processUserMessage(
        `Task type: ${taskSnapshot.type}\nPayload: ${JSON.stringify(redactedPayload)}\nContext: ${JSON.stringify(redactedContext)}`
      );

      const finalMessage = result[result.length - 1]?.content ?? "Task completed";
      const taskResult: TaskResult = {
        success: true,
        output: finalMessage,
      };

      this.emit("taskCompleted", { task: taskSnapshot, result: taskResult });
      return taskResult;
    } catch (error) {
      const taskResult: TaskResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit("taskFailed", { task: taskSnapshot, result: taskResult });
      return taskResult;
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  private async getOrCreateWorker(type: Task["type"]): Promise<GrokAgent> {
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
