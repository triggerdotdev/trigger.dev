// P1: XAUTOCLAIM must thread its continuation cursor so a PEL larger than the per-call scan window is
// swept end to end, even when front entries stay pending (retry). Real Redis stream + consumer group is
// the infra under test; the prepared-unit store and Postgres-status check are pure injected builders
// (the retry path never touches Postgres). No mocks of infrastructure.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { PendingIndex, RECOVERY_CONSUMER_GROUP } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  type PostgresCommitStatus,
  type RecoveryDeps,
} from "./pendingRecoveryWorker.js";
import { pendingStreamKey } from "./snapshotKeys.js";

// One valid mirrored prepared unit per runId, transition token matching the stream entry's field so
// resolveEntry proceeds to the Postgres-status check (which we pin to "in progress" => retry).
function preparedUnitJson(runId: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    transitionToken: "tok",
    postgresXid: "1",
    runId,
    organizationId: "org_1",
    residency: "mirrored",
    logicalRunStoreRoute: "logical:1",
    entries: [
      {
        entry: {
          id: "s1",
          runId,
          engine: "V2",
          executionStatus: "EXECUTING",
          description: "d",
          runStatus: "EXECUTING",
          createdAt: "2026-08-21T00:00:00.000Z",
          environmentId: "env_1",
          environmentType: "PRODUCTION",
          projectId: "proj_1",
          organizationId: "org_1",
        },
        kind: "transition",
        isTerminal: false,
        expectedCur: "s0",
      },
    ],
  });
}

describe("PendingRecoveryWorker autoclaim cursor (P1)", () => {
  redisTest(
    "a PEL larger than the scan window is swept to the tail within bounded ticks",
    async ({ redisOptions }) => {
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(raw);
      const partition = 0;
      const N = 30;
      const COUNT = 5;

      await index.ensureGroup(partition);
      // Build a PEL of N entries: XADD then deliver all to a dead consumer so they sit idle in the PEL.
      for (let i = 0; i < N; i++) {
        await raw.xadd(
          pendingStreamKey(partition),
          "*",
          "runId",
          `run_${String(i).padStart(3, "0")}`,
          "transitionToken",
          "tok"
        );
      }
      await raw.xreadgroup(
        "GROUP",
        RECOVERY_CONSUMER_GROUP,
        "dead",
        "COUNT",
        N,
        "STREAMS",
        pendingStreamKey(partition),
        ">"
      );

      const visited = new Set<string>();
      const store: RecoveryDeps["store"] = {
        readPreparedUnitRaw: async (runId: string) => {
          visited.add(runId);
          return preparedUnitJson(runId);
        },
        finalize: async () => {
          throw new Error("finalize should not run on the retry path");
        },
        abortPrepared: async () => {
          throw new Error("abortPrepared should not run on the retry path");
        },
      };
      const deps: RecoveryDeps = {
        store,
        pendingIndex: index,
        // Every entry stays pending (retry) so the PEL never drains; the cursor is the only way the
        // window can advance past the front.
        checkPostgresCommit: async (): Promise<PostgresCommitStatus> => "in progress",
        commitProbeExists: async () => false,
        quarantine: async () => {},
      };
      const worker = new PendingRecoveryWorker(deps);

      const tail = `run_${String(N - 1).padStart(3, "0")}`;
      let ticks = 0;
      const maxTicks = 8; // ceil(30/5) = 6 sweeps the whole PEL; a couple of spare ticks for slack.
      while (!visited.has(tail) && ticks < maxTicks) {
        await worker.processPartition(partition, "recovery", { minIdleMs: 0, count: COUNT });
        ticks++;
      }

      expect(visited.has(tail)).toBe(true);
      expect(visited.size).toBe(N);
      expect(ticks).toBeLessThanOrEqual(Math.ceil(N / COUNT) + 1);

      await raw.quit();
    }
  );
});
