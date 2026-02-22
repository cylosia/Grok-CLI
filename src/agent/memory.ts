export class AgentMemory {
  private memory: Map<string, unknown> = new Map();
  private userProfile: Map<string, unknown> = new Map();

  async store(key: string, data: unknown): Promise<void> {
    this.memory.set(key, data);
  }

  async recall(key: string): Promise<unknown> {
    return this.memory.get(key);
  }

  async updateProfile(key: string, value: unknown): Promise<void> {
    this.userProfile.set(key, value);
  }

  async getProfile(key: string): Promise<unknown> {
    return this.userProfile.get(key);
  }
}
