import {
  BUFFER_DEADLOCK_RECOVERY_CONFLICT,
  SNAPSHOT_RECOVERY_CONFLICT,
  connectReaderClient,
  heteroRunOpsPostgresTest,
  installRecoveryConflictGate,
  type ReaderClientDriver,
  type RecoveryConflictGate,
} from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { TokenBucketRetryBudget } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { isReadReplicaClient, markReadReplicaClient } from "./readReplicaClient.js";
import {
  isReplicaRecoveryConflictError,
  replicaRecoveryConflictSqlstate,
  type ReplicaRecoveryConflictInfo,
  type ReplicaRecoveryConflictRetryOptions,
  withReplicaRecoveryConflictRetry,
} from "./replicaRecoveryConflictRetry.js";
import { seedRecoveryConflictRun as seedRun } from "./testFixtures/recoveryConflictRun.js";

// The retry wraps the dedicated run-ops replicas (new and gen-2 shards), whose separately generated
// Prisma runtime is run over both drivers production uses.
const DRIVERS: ReaderClientDriver[] = ["engine", "adapter"];

const RETRY: ReplicaRecoveryConflictRetryOptions = {
  maxAttempts: 3,
  backoffMinMs: 0,
  backoffMaxMs: 0,
};

const ORDINARY_DEADLOCK = { sqlstate: "40P01", message: "deadlock detected" };
const STATEMENT_TIMEOUT = {
  sqlstate: "57014",
  message: "canceling statement due to statement timeout",
};

type Harness = {
  gate: RecoveryConflictGate;
  run: { runId: string; friendlyId: string; environmentId: string };
  /** The gated reader wrapped and branded as the webapp builds a run-ops replica. */
  replica: RunOpsPrismaClient;
  /** The same gated reader without the retry. */
  bareReplica: RunOpsPrismaClient;
  /** A store reading through `replica`, as the router's owning store does. */
  store: PostgresRunStore;
  retries: Array<{ model?: string; operation: string; attempt: number; sqlstate?: string }>;
};

async function withHarness(
  ctx: { uri17: string; prisma17: RunOpsPrismaClient },
  driver: ReaderClientDriver,
  body: (h: Harness) => Promise<void>,
  retryOptions: Partial<ReplicaRecoveryConflictRetryOptions> = {}
) {
  const run = await seedRun(ctx.prisma17);

  const gate = await installRecoveryConflictGate(ctx.uri17, "TaskRun");
  const reader = connectReaderClient(gate.readerUri, driver);
  const retries: Harness["retries"] = [];
  const replica = markReadReplicaClient(
    withReplicaRecoveryConflictRetry(reader.client, {
      ...RETRY,
      ...retryOptions,
      onRetry: (info) => retries.push(info),
    })
  );
  const store = new PostgresRunStore({
    prisma: ctx.prisma17 as never,
    readOnlyPrisma: replica as never,
    schemaVariant: "dedicated",
  });

  try {
    await body({ gate, run, replica, bareReplica: reader.client, store, retries });
  } finally {
    try {
      await reader.disconnect();
    } finally {
      await gate.close();
    }
  }
}

describe("replica recovery-conflict retry", () => {
  for (const driver of DRIVERS) {
    describe(`run-ops replica, ${driver}`, () => {
      heteroRunOpsPostgresTest(
        "without the retry, a recovery conflict fails the read with the production error",
        async ({ uri17, prisma17 }) => {
          await withHarness({ uri17, prisma17 }, driver, async ({ gate, run, bareReplica }) => {
            await gate.failNext(1, BUFFER_DEADLOCK_RECOVERY_CONFLICT);
            const error = await bareReplica.taskRun
              .findFirst({ where: { id: run.runId } })
              .catch((e: unknown) => e);
            expect(error).toMatchObject({ name: "PrismaClientUnknownRequestError" });
            expect(String((error as Error).message)).toContain(
              "canceling statement due to conflict with recovery"
            );
            expect(await gate.evaluations()).toBe(1);
          });
        }
      );

      heteroRunOpsPostgresTest(
        "a 40P01 buffer-deadlock conflict on a run read is retried and the read succeeds",
        async ({ uri17, prisma17 }) => {
          await withHarness({ uri17, prisma17 }, driver, async ({ gate, run, store, retries }) => {
            await gate.failNext(1, BUFFER_DEADLOCK_RECOVERY_CONFLICT);
            const found = await store.findRun({ id: run.runId }, { select: { id: true } });
            expect(found).toEqual({ id: run.runId });
            expect(await gate.evaluations()).toBe(2);
            expect(retries).toEqual([
              expect.objectContaining({ model: "TaskRun", attempt: 1, sqlstate: "40P01" }),
            ]);
          });
        }
      );

      heteroRunOpsPostgresTest(
        "a 40001 conflict (Prisma P2034) on a run read is retried and the read succeeds",
        async ({ uri17, prisma17 }) => {
          await withHarness({ uri17, prisma17 }, driver, async ({ gate, run, store, retries }) => {
            await gate.failNext(2, SNAPSHOT_RECOVERY_CONFLICT);
            const found = await store.findRun({
              friendlyId: run.friendlyId,
              runtimeEnvironmentId: run.environmentId,
            });
            expect(found?.id).toBe(run.runId);
            expect(await gate.evaluations()).toBe(3);
            expect(retries.map((r) => r.sqlstate)).toEqual(["40001", "40001"]);
          });
        }
      );

      heteroRunOpsPostgresTest(
        "a read inside a batch transaction is not retried",
        async ({ uri17, prisma17 }) => {
          await withHarness(
            { uri17, prisma17 },
            driver,
            async ({ gate, run, replica, retries }) => {
              await gate.failNext(1, BUFFER_DEADLOCK_RECOVERY_CONFLICT);
              const client = replica;
              await expect(
                client.$transaction([client.taskRun.findFirst({ where: { id: run.runId } })])
              ).rejects.toThrow("conflict with recovery");
              expect(await gate.evaluations()).toBe(1);
              expect(retries).toEqual([]);
            }
          );
        }
      );

      heteroRunOpsPostgresTest(
        "a recovery conflict on a raw replica query (Prisma P2010) is retried",
        async ({ uri17, prisma17 }) => {
          await withHarness(
            { uri17, prisma17 },
            driver,
            async ({ gate, run, replica, bareReplica, retries }) => {
              for (const conflict of [
                BUFFER_DEADLOCK_RECOVERY_CONFLICT,
                SNAPSHOT_RECOVERY_CONFLICT,
              ]) {
                // The shape the retry has to recognise, as the client raises it unwrapped.
                await gate.failNext(1, conflict);
                const error =
                  await bareReplica.$queryRaw`SELECT id FROM "TaskRun" WHERE id = ${run.runId}`.catch(
                    (e: unknown) => e
                  );
                expect(error).toMatchObject({
                  name: "PrismaClientKnownRequestError",
                  code: "P2010",
                  meta: { code: conflict.sqlstate },
                });

                retries.length = 0;
                await gate.failNext(1, conflict);
                const rows = await replica.$queryRaw<
                  Array<{ id: string }>
                >`SELECT id FROM "TaskRun" WHERE id = ${run.runId}`;
                expect(rows).toEqual([{ id: run.runId }]);
                expect(await gate.evaluations()).toBe(2);
                expect(retries).toEqual([
                  expect.objectContaining({ operation: "$queryRaw", sqlstate: conflict.sqlstate }),
                ]);
              }
            }
          );
        }
      );

      heteroRunOpsPostgresTest(
        "a conflict that persists is attempted maxAttempts times, then the last error surfaces",
        async ({ uri17, prisma17 }) => {
          await withHarness({ uri17, prisma17 }, driver, async ({ gate, run, store }) => {
            await gate.failNext(100, SNAPSHOT_RECOVERY_CONFLICT);
            const error = await store.findRun({ id: run.runId }).catch((e: unknown) => e);
            expect(isReplicaRecoveryConflictError(error)).toBe(true);
            expect(error).toMatchObject({ code: "P2034" });
            expect(await gate.evaluations()).toBe(3);
          });
        }
      );

      heteroRunOpsPostgresTest(
        "an ordinary deadlock or a statement timeout is not retried",
        async ({ uri17, prisma17 }) => {
          await withHarness({ uri17, prisma17 }, driver, async ({ gate, run, store, retries }) => {
            for (const error of [ORDINARY_DEADLOCK, STATEMENT_TIMEOUT]) {
              await gate.failNext(1, error);
              await expect(store.findRun({ id: run.runId })).rejects.toThrow(error.message);
              expect(await gate.evaluations()).toBe(1);
            }
            expect(retries).toEqual([]);
          });
        }
      );

      heteroRunOpsPostgresTest(
        "a read inside an interactive transaction is not retried",
        async ({ uri17, prisma17 }) => {
          await withHarness(
            { uri17, prisma17 },
            driver,
            async ({ gate, run, replica, retries }) => {
              await gate.failNext(1, BUFFER_DEADLOCK_RECOVERY_CONFLICT);
              await expect(
                replica.$transaction((tx) => tx.taskRun.findFirst({ where: { id: run.runId } }))
              ).rejects.toThrow("conflict with recovery");
              expect(await gate.evaluations()).toBe(1);
              expect(retries).toEqual([]);
            }
          );
        }
      );
    });
  }

  heteroRunOpsPostgresTest(
    "extensions added before the retry see one call per read, and the brand applied after it holds",
    async ({ uri17, prisma17 }) => {
      await withHarness({ uri17, prisma17 }, "engine", async ({ gate, run, bareReplica }) => {
        // Stands in for the datasource tagging and error capture the webapp adds first.
        const earlierCalls: string[] = [];
        const tagged = bareReplica.$extends({
          query: {
            $allOperations: async ({ operation, args, query }) => {
              earlierCalls.push(operation);
              return query(args);
            },
          },
        });
        const replica = markReadReplicaClient(withReplicaRecoveryConflictRetry(tagged, RETRY));

        await gate.failNext(1, BUFFER_DEADLOCK_RECOVERY_CONFLICT);
        await replica.taskRun.findFirst({ where: { id: run.runId } });

        expect(await gate.evaluations()).toBe(2);
        expect(earlierCalls).toEqual(["findFirst"]);
        expect(isReadReplicaClient(replica)).toBe(true);
      });
    }
  );

  heteroRunOpsPostgresTest(
    "closing the gate drops its reader role",
    async ({ uri17, prisma17 }) => {
      const gate = await installRecoveryConflictGate(uri17, "TaskRun");
      const role = new URL(gate.readerUri).username;
      await gate.close();
      const remaining = await prisma17.$queryRaw<
        Array<{ rolname: string }>
      >`SELECT rolname FROM pg_roles WHERE rolname = ${role}`;
      expect(remaining).toEqual([]);
    }
  );

  heteroRunOpsPostgresTest(
    "a gate that fails to install drops its reader role",
    async ({ uri17, prisma17 }) => {
      const readerRoles = async () =>
        (
          await prisma17.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) AS count FROM pg_roles WHERE rolname LIKE 'rc_reader_%'`
        )[0]?.count;
      const before = await readerRoles();
      await expect(installRecoveryConflictGate(uri17, "NoSuchTable")).rejects.toThrow(
        'relation "NoSuchTable" does not exist'
      );
      expect(await readerRoles()).toBe(before);
    }
  );

  heteroRunOpsPostgresTest(
    "an exhausted retry budget surfaces the conflict without retrying, and reports it",
    async ({ uri17, prisma17 }) => {
      const exhausted: ReplicaRecoveryConflictInfo[] = [];
      await withHarness(
        { uri17, prisma17 },
        "engine",
        async ({ gate, run, store, retries }) => {
          await gate.failNext(1, BUFFER_DEADLOCK_RECOVERY_CONFLICT);
          await expect(store.findRun({ id: run.runId })).rejects.toThrow("conflict with recovery");
          expect(await gate.evaluations()).toBe(1);
          expect(retries).toEqual([]);
          expect(exhausted).toEqual([
            { model: "TaskRun", operation: "findFirst", sqlstate: "40P01" },
          ]);
        },
        {
          budget: new TokenBucketRetryBudget({ ratePerSec: 0, burst: 0 }),
          onBudgetExhausted: (info) => exhausted.push(info),
        }
      );
    }
  );

  heteroRunOpsPostgresTest(
    "an error that is not a recovery conflict never reaches the budget",
    async ({ uri17, prisma17 }) => {
      const exhausted: ReplicaRecoveryConflictInfo[] = [];
      await withHarness(
        { uri17, prisma17 },
        "engine",
        async ({ gate, run, store }) => {
          await gate.failNext(1, STATEMENT_TIMEOUT);
          await expect(store.findRun({ id: run.runId })).rejects.toThrow("statement timeout");
          expect(exhausted).toEqual([]);
        },
        {
          budget: new TokenBucketRetryBudget({ ratePerSec: 0, burst: 0 }),
          onBudgetExhausted: (info) => exhausted.push(info),
        }
      );
    }
  );
});

describe("replicaRecoveryConflictSqlstate", () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code, meta });
  const unknown = (message: string) =>
    Object.assign(new Error(message), { name: "PrismaClientUnknownRequestError" });

  it("classifies each shape", () => {
    expect(replicaRecoveryConflictSqlstate(known("P2034", { modelName: "TaskRun" }))).toBe("40001");
    expect(
      replicaRecoveryConflictSqlstate(
        known("P2010", {
          code: "40P01",
          message: "canceling statement due to conflict with recovery",
        })
      )
    ).toBe("40P01");
    expect(
      replicaRecoveryConflictSqlstate(
        known("P2010", { code: "40P01", message: "deadlock detected" })
      )
    ).toBeUndefined();
    expect(
      replicaRecoveryConflictSqlstate(
        unknown(
          'PostgresError { code: "40P01", message: "canceling statement due to conflict with recovery" }'
        )
      )
    ).toBe("40P01");
    expect(
      replicaRecoveryConflictSqlstate(
        unknown('PostgresError { code: "40P01", message: "deadlock detected" }')
      )
    ).toBeUndefined();
    expect(replicaRecoveryConflictSqlstate(known("P2002"))).toBeUndefined();
    expect(replicaRecoveryConflictSqlstate(new Error("conflict with recovery"))).toBeUndefined();
  });
});
