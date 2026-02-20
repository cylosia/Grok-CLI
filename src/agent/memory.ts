export class AgentMemory {
  private memory: Map<string, unknown> = new Map();
  private userProfile: Map<string, unknown> = new Map();

  async store(key: string, data: unknown): Promise<void> {
    this.memory.set(key, data);
  }

  async recall<T>(key: string): Promise<T | undefined> {
    return this.memory.get(key) as T | undefined;
  }

  async updateProfile(key: string, value: unknown): Promise<void> {
    this.userProfile.set(key, value);
  }

  async getProfile<T>(key: string): Promise<T | undefined> {
    return this.userProfile.get(key) as T | undefined;
  }
}
