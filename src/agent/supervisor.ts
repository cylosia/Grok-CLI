import { EventEmitter } from "events";
import { GrokAgent } from "./grok-agent.js";
import { Repomap2 } from "./repomap.js";
import { getSettingsManager } from "../utils/settings-manager.js";

export interface Task {
  id: string;
  type: "edit" | "git" | "search" | "mcp" | "reason";
  payload: any;
  priority: number;
  context?: any;
}

export interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  artifacts?: any;
}

export class AgentSupervisor extends EventEmitter {
  private mainAgent: GrokAgent;
  private workers: Map<string, GrokAgent> = new Map();
  private repomap: Repomap2;
  private activeTasks: Map<string, Task> = new Map();
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
    this.mainAgent = new GrokAgent(apiKey);
    this.repomap = new Repomap2();
  }

  async executeTask(task: Task): Promise<TaskResult> {
    this.activeTasks.set(task.id, task);
    this.emit("taskStarted", task);

    const relevantFiles = await this.repomap.getRelevantFiles(task.payload.query || task.payload, 8);
    task.context = { ...task.context, relevantFiles };

    const worker = await this.getOrCreateWorker(task.type);
    const result = await worker.delegate(task);

    this.activeTasks.delete(task.id);
    this.emit("taskCompleted", { task, result });

    return result;
  }

  private async getOrCreateWorker(type: string): Promise<GrokAgent> {
    if (!this.workers.has(type)) {
      const worker = new GrokAgent(this.apiKey);
      this.workers.set(type, worker);
    }
    return this.workers.get(type)!;
  }
}
