import type { Redis } from "@internal/redis";
import { RunQueueFullKeyProducer } from "../../keyProducer.js";
import type { QueueDescriptor } from "../../types.js";

export const keys = new RunQueueFullKeyProducer();

const ENV = { organization: { id: "o" }, project: { id: "p" }, id: "e" } as const;

export function queueKeyFor(name: string): string {
  return keys.queueKey(ENV as never, name);
}

export function descriptorFor(name: string): QueueDescriptor {
  return keys.descriptorFromQueue(queueKeyFor(name));
}

/**
 * Minimal in-memory stand-in for the bits of ioredis that SpikeQueueReader uses
 * (`zrange` over the master queue and over each queue's head). `active` is the
 * list of queue base-names currently present, each with a head score.
 */
export function fakeRedis(active: Array<{ name: string; head: number }>): Redis {
  return {
    async zrange(_key: string, _start: number, _stop: number, withScores?: string): Promise<string[]> {
      // Only the master-queue WITHSCORES read is used by the reader now.
      if (withScores) {
        return active.flatMap((q) => [queueKeyFor(q.name), String(q.head)]);
      }
      return active.map((q) => queueKeyFor(q.name));
    },
  } as unknown as Redis;
}
