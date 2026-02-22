const MAX_MEMORY_ENTRIES = 1000;
const MAX_PROFILE_ENTRIES = 100;

export class AgentMemory {
  private memory: Map<string, unknown> = new Map();
  private userProfile: Map<string, unknown> = new Map();

  async store(key: string, data: unknown): Promise<void> {
    if (this.memory.size >= MAX_MEMORY_ENTRIES && !this.memory.has(key)) {
      // Evict oldest entry (first key by insertion order)
      const firstKey = this.memory.keys().next().value;
      if (firstKey !== undefined) {
        this.memory.delete(firstKey);
      }
    }
    this.memory.set(key, data);
  }

  async recall(key: string): Promise<unknown> {
    return this.memory.get(key);
  }

  async updateProfile(key: string, value: unknown): Promise<void> {
    if (this.userProfile.size >= MAX_PROFILE_ENTRIES && !this.userProfile.has(key)) {
      const firstKey = this.userProfile.keys().next().value;
      if (firstKey !== undefined) {
        this.userProfile.delete(firstKey);
      }
    }
    this.userProfile.set(key, value);
  }

  async getProfile(key: string): Promise<unknown> {
    return this.userProfile.get(key);
  }
}
