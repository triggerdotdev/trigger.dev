import {
  connectReaderClient,
  type HotStandby,
  hotStandbyTest,
  type ReaderClientDriver,
} from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { markReadReplicaClient } from "./readReplicaClient.js";
import {
  replicaRecoveryConflictSqlstate,
  withReplicaRecoveryConflictRetry,
} from "./replicaRecoveryConflictRetry.js";
import { seedRecoveryConflictRun } from "./testFixtures/recoveryConflictRun.js";

// The same retry the plain-Postgres tests drive with a gate, here against cancellations a real hot
// standby raises during WAL replay.

const DRIVERS: ReaderClientDriver[] = ["engine", "adapter"];

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to be cancelled, but it succeeded");
}

async function poll(what: string, check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function seed(hotStandby: HotStandby) {
  const writer = connectReaderClient(hotStandby.primaryUrl, "engine");
  try {
    return await seedRecoveryConflictRun(writer.client);
  } finally {
    await writer.disconnect();
    await hotStandby.waitForReplay();
  }
}

function wrappedReplica(client: RunOpsPrismaClient) {
  const retries: Array<{ model?: string; operation: string; attempt: number; sqlstate?: string }> =
    [];
  const replica = markReadReplicaClient(
    withReplicaRecoveryConflictRetry(client, {
      maxAttempts: 3,
      backoffMinMs: 25,
      backoffMaxMs: 100,
      onRetry: (info) => retries.push(info),
    })
  );
  return { replica, retries };
}

describe("replica recovery-conflict retry on a real hot standby", () => {
  hotStandbyTest(
    "a lock conflict (40001) is recognised in every shape, and a run read through the store recovers",
    { timeout: 300_000 },
    async ({ hotStandby }) => {
      const run = await seed(hotStandby);

      for (const driver of DRIVERS) {
        const reader = connectReaderClient(hotStandby.standbyUrl, driver);
        const bare = reader.client;
        try {
          // Connect first, so the read under test is the one that blocks.
          await bare.taskRun.findFirst({ where: { id: run.runId }, select: { id: true } });

          // The bare client surfaces the cancellation in the shapes the classifier expects.
          for (const kind of ["model", "raw"] as const) {
            const before = await hotStandby.conflicts();
            const conflict = await hotStandby.armLockConflict("TaskRun");
            try {
              const cancelled = caught(
                kind === "model"
                  ? bare.taskRun.findFirst({ where: { id: run.runId }, select: { id: true } })
                  : bare.$queryRawUnsafe(`SELECT id FROM "TaskRun" LIMIT 1`)
              );
              await conflict.waitForBlockedRead();
              await conflict.fire();
              const error = await cancelled;

              expect(error, `${driver} ${kind}`).toMatchObject(
                kind === "model"
                  ? { name: "PrismaClientKnownRequestError", code: "P2034" }
                  : {
                      name: "PrismaClientKnownRequestError",
                      code: "P2010",
                      meta: { code: "40001" },
                    }
              );
              expect(replicaRecoveryConflictSqlstate(error), `${driver} ${kind}`).toBe("40001");
              expect((await hotStandby.conflicts()).lock, driver).toBe(before.lock + 1);
            } finally {
              await conflict.release();
            }
          }

          // Through the wrapped replica and the store, the cancelled read is retried. The retry
          // blocks on the still-armed lock and completes once it is released.
          const { replica, retries } = wrappedReplica(bare);
          const store = new PostgresRunStore({
            prisma: bare as never,
            readOnlyPrisma: replica as never,
            schemaVariant: "dedicated",
          });
          const before = await hotStandby.conflicts();
          const conflict = await hotStandby.armLockConflict("TaskRun");
          try {
            const found = store.findRun({ id: run.runId }, { select: { id: true } });
            await conflict.waitForBlockedRead();
            await conflict.fire();
            await poll(`${driver}: the retry`, () => retries.length === 1);
            await conflict.release();

            await expect(found, driver).resolves.toEqual({ id: run.runId });
            expect(retries, driver).toEqual([
              expect.objectContaining({ model: "TaskRun", attempt: 1, sqlstate: "40001" }),
            ]);
            expect((await hotStandby.conflicts()).lock, driver).toBe(before.lock + 1);
          } finally {
            await conflict.release();
          }
        } finally {
          await reader.disconnect();
        }
      }
    }
  );

  // The backend-side buffer deadlock: replay already waits on a buffer pin the read's transaction
  // holds (an open cursor) when the read starts waiting on a lock replay holds. A plain model read
  // can't be driven into this ordering on demand, so this checks the 40P01 shape a real standby
  // produces, and that a read inside a transaction is not retried.
  hotStandbyTest(
    "a buffer deadlock with replay (40P01) is recognised, and is not retried inside a transaction",
    { timeout: 300_000 },
    async ({ hotStandby }) => {
      await seed(hotStandby);
      await hotStandby.primarySql([
        "CREATE TABLE hot_standby_pin (id int PRIMARY KEY, v int NOT NULL)",
        "INSERT INTO hot_standby_pin SELECT i, 0 FROM generate_series(1, 20) i",
      ]);
      // Long enough for the standby's deadlock check to run before replay gives up waiting.
      await hotStandby.setMaxStandbyStreamingDelay(30_000);

      let n = 0;
      for (const driver of DRIVERS) {
        for (const kind of ["model", "raw"] as const) {
          const label = `${driver} ${kind}`;
          // Fresh unfrozen tuples, so the VACUUM FREEZE below logs a freeze that needs the pin.
          await hotStandby.primarySql("UPDATE hot_standby_pin SET v = v + 1");
          await hotStandby.waitForReplay();

          const reader = connectReaderClient(hotStandby.standbyUrl, driver);
          const { replica, retries } = wrappedReplica(reader.client);
          const gid = `pin_${++n}`;
          try {
            const error = await caught(
              replica.$transaction(
                async (tx) => {
                  await tx.$executeRawUnsafe(
                    "DECLARE pin CURSOR FOR SELECT id FROM hot_standby_pin"
                  );
                  await tx.$queryRawUnsafe("FETCH FORWARD 1 FROM pin");
                  await hotStandby.primarySql([
                    "BEGIN",
                    `LOCK TABLE "TaskRun" IN ACCESS EXCLUSIVE MODE`,
                    `PREPARE TRANSACTION '${gid}'`,
                  ]);
                  // Replay takes the lock, then waits on our pin to apply the freeze.
                  await hotStandby.primarySql("VACUUM FREEZE hot_standby_pin");
                  await hotStandby.waitForReplayBlockedOnPin();
                  await (kind === "model"
                    ? tx.taskRun.findFirst({ select: { id: true } })
                    : tx.$queryRawUnsafe(`SELECT id FROM "TaskRun" LIMIT 1`));
                },
                { timeout: 20_000, maxWait: 10_000 }
              )
            );

            expect(error, label).toMatchObject(
              kind === "model"
                ? { name: "PrismaClientUnknownRequestError" }
                : { name: "PrismaClientKnownRequestError", code: "P2010", meta: { code: "40P01" } }
            );
            expect(String((error as Error).message), label).toMatch(/conflict with recovery/);
            expect(replicaRecoveryConflictSqlstate(error), label).toBe("40P01");
            expect(retries, label).toEqual([]);
          } finally {
            await hotStandby.primarySql(`COMMIT PREPARED '${gid}'`).catch(() => {});
            await reader.disconnect();
          }
        }
      }
    }
  );
});
