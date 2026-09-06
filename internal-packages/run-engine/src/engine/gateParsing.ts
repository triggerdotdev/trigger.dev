/**
 * The gate contract for stored/untyped gate values (BackgroundWorkerTask.gates,
 * TaskRun.gates are Json columns): keep only well-shaped entries so a malformed
 * value can never fail a trigger or an enqueue. A gate needs a queue name within
 * the manifest bounds (1-128 chars); a literal concurrency key must fit the same
 * bounds, and an empty-string key means "omitted" so the gate inherits the run's
 * key. At most three gates apply: a task's anonymous inline-limit gate plus two
 * named limits.
 */
export type ParsedGate = { queue: string; concurrencyKey?: string };

export function parseGates(gates: unknown): ParsedGate[] {
  if (!Array.isArray(gates) || gates.length === 0) {
    return [];
  }

  const parsed = gates.flatMap((gate): ParsedGate[] => {
    if (!gate || typeof gate !== "object" || typeof (gate as any).queue !== "string") {
      return [];
    }
    const queue = (gate as any).queue;
    if (queue.length === 0 || queue.length > 128) {
      return [];
    }
    const rawKey = (gate as any).concurrencyKey;
    if (typeof rawKey === "string" && rawKey.length > 128) {
      return [];
    }
    const concurrencyKey = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : undefined;
    return [{ queue, concurrencyKey }];
  });

  return parsed.slice(0, 3);
}
