/**
 * Deterministic 0-99 bucket for an org id, stable across processes and deploys.
 * FNV-1a (non-crypto): we only need determinism + uniform spread, not collision
 * resistance. Used for nested percentage rollout: `hashBucket(orgId) < percentage`.
 * Ramping the percentage down keeps a strict subset (the low buckets), so an org
 * never flaps in and out as the dial moves.
 */
export function hashBucket(orgId: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < orgId.length; i++) {
    hash ^= orgId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}
