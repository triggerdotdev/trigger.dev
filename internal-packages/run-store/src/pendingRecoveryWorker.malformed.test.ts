// F10: the synchronous read-path pending resolution delegates parsing/validation to the recovery
// resolution. Malformed data is quarantined immediately (never thrown out of the read), the RAW value
// is preserved for inspection, and the pending marker is not deleted-and-retried. Real Redis.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { preparedUnitKey } from "./snapshotKeys.js";
import { PendingIndex } from "./pendingIndex.js";
import { PendingRecoveryWorker } from "./pendingRecoveryWorker.js";

describe("synchronous pending resolution delegates to the recovery worker (F10)", () => {
  redisTest(
    "malformed pending data is quarantined with the raw value preserved, not thrown out of the read",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(raw);
      const worker = new PendingRecoveryWorker({
        pendingIndex: index,
        store,
        // Never reached on the malformed path (quarantine happens first), but required seams.
        checkPostgresCommit: async () => null,
        commitProbeExists: async () => false,
        quarantine: (unit, reason, rawMalformed) =>
          store.quarantinePreparedUnit(unit, reason, rawMalformed),
      });
      try {
        const runId = "run_malformed";
        const malformed = "{ this is not valid json";
        await raw.hset(preparedUnitKey(runId), "unit", malformed);

        // The synchronous read-path resolver passes NO token; it must delegate here and quarantine.
        const outcome = await worker.resolveEntry({ id: "resolve-pending", fields: { runId } });
        expect(outcome.kind).toBe("quarantined");
        expect(outcome.reason).toBe("structurally-invalid");

        // The raw malformed value is preserved verbatim for inspection.
        const quarantined = await store.readQuarantinedUnit(runId);
        expect(quarantined?.reason).toBe("structurally-invalid");
        expect(quarantined?.raw).toBe(malformed);

        // The pending marker was NOT deleted-and-retried into an absent/Postgres result.
        expect(await raw.exists(preparedUnitKey(runId))).toBe(1);
      } finally {
        await raw.quit().catch(() => undefined);
        await store.quit();
      }
    }
  );
});
