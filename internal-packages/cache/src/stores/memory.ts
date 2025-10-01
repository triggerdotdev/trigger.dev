import { MemoryStore } from "@unkey/cache/stores";

export type { MemoryStore };

export function createMemoryStore(maxItems: number, frequency: number = 0.01) {
  return new MemoryStore({
    persistentMap: new Map(),
    unstableEvictOnSet: {
      frequency,
      maxItems,
    },
  });
}
