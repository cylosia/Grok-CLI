import { GrokAgent } from "./grok-agent.js";

export class AgentMemory {
  private memory: Map<string, any> = new Map();
  private userProfile: Map<string, any> = new Map();

  async store(key: string, data: any) {
    this.memory.set(key, data);
  }

  async recall(key: string) {
    return this.memory.get(key);
  }

  async updateProfile(key: string, value: any) {
    this.userProfile.set(key, value);
  }

  async getProfile() {
    return Object.fromEntries(this.userProfile);
  }
}
