/** FNV-1a 32-bit hash. Deterministic across processes; used only for sharding. */
export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic shard index in [0, shardCount) for a key. */
export function shardFor(key: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  return fnv1a32(key) % shardCount;
}
