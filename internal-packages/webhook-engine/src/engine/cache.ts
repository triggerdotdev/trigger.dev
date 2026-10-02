import type { WebhookEndpoint } from "@trigger.dev/database";
import type { ParsedRoutingTarget } from "./targets.js";

/**
 * What the ingest hot path needs to verify and persist a delivery, resolved once per endpoint and
 * reused within the TTL: the endpoint row, its plaintext signing secret and its parsed routing targets.
 */
export type CachedEndpoint = {
  endpoint: WebhookEndpoint;
  secret: string;
  targets: ParsedRoutingTarget[];
};

// Minimal in-memory TTL cache with FIFO eviction at maxSize. ttlMs <= 0 disables it (every get misses).
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): V | undefined {
    if (!this.enabled) return undefined;
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    if (this.map.size >= this.maxSize && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}
