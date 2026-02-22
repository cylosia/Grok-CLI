const MAX_MEMORY_ENTRIES = 1000;
const MAX_PROFILE_ENTRIES = 200;

function evictOldest(map: Map<string, unknown>, maxSize: number): void {
  while (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (typeof oldest === "string") {
      map.delete(oldest);
    } else {
      break;
    }
  }
}

export class AgentMemory {
  private memory: Map<string, unknown> = new Map();
  private userProfile: Map<string, unknown> = new Map();

  async store(key: string, data: unknown): Promise<void> {
    // Re-insert to maintain LRU order
    this.memory.delete(key);
    evictOldest(this.memory, MAX_MEMORY_ENTRIES);
    this.memory.set(key, data);
  }

  async recall(key: string): Promise<unknown> {
    return this.memory.get(key);
  }

  async updateProfile(key: string, value: unknown): Promise<void> {
    this.userProfile.delete(key);
    evictOldest(this.userProfile, MAX_PROFILE_ENTRIES);
    this.userProfile.set(key, value);
  }

  async getProfile(key: string): Promise<unknown> {
    return this.userProfile.get(key);
  }
}
