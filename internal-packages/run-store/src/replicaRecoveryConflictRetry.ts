import { type RetryBudget, withInfraRetry } from "@trigger.dev/database";

// A hot-standby replica cancels a read that blocks WAL replay ("canceling statement due to conflict
// with recovery"). The cancellation is what lets replay continue, so the same read a moment later
// normally succeeds. Prisma surfaces it in three shapes, all recognised here by name/code/message
// rather than `instanceof`, because the run-ops client is a separately generated Prisma runtime:
//   - SQLSTATE 40P01 (buffer deadlock with recovery) on a model read: PrismaClientUnknownRequestError
//     whose message embeds `PostgresError { code: "40P01", message: "canceling statement due to
//     conflict with recovery", ... }`.
//   - SQLSTATE 40001 (snapshot, lock, buffer pin or tablespace conflict) on a model read: P2034
//     "Transaction failed due to a write conflict or a deadlock", with the server message dropped.
//   - Either SQLSTATE on a raw query: P2010 with `meta.code` and `meta.message`.
// A bare P2034 is accepted because this check is only applied to replica reads outside a
// transaction, where a standby can raise 40001 only for a recovery conflict.
const RECOVERY_CONFLICT_MESSAGE = /conflict with recovery/i;
const RECOVERY_CONFLICT_SQLSTATES = new Set(["40001", "40P01"]);
const EMBEDDED_SQLSTATE = /code: "(40001|40P01)"/;

/** The SQLSTATE of a standby recovery-conflict cancellation, or undefined for any other error. */
export function replicaRecoveryConflictSqlstate(error: unknown): string | undefined {
  const name = (error as { name?: unknown })?.name;
  const code = (error as { code?: unknown })?.code;
  const message = (error as { message?: unknown })?.message;

  if (name === "PrismaClientKnownRequestError") {
    if (code === "P2034") {
      return "40001";
    }
    if (code === "P2010") {
      const meta = (error as { meta?: { code?: unknown; message?: unknown } }).meta;
      if (
        typeof meta?.code === "string" &&
        RECOVERY_CONFLICT_SQLSTATES.has(meta.code) &&
        typeof meta.message === "string" &&
        RECOVERY_CONFLICT_MESSAGE.test(meta.message)
      ) {
        return meta.code;
      }
    }
    return undefined;
  }

  if (
    name === "PrismaClientUnknownRequestError" &&
    typeof message === "string" &&
    RECOVERY_CONFLICT_MESSAGE.test(message)
  ) {
    return EMBEDDED_SQLSTATE.exec(message)?.[1];
  }

  return undefined;
}

export function isReplicaRecoveryConflictError(error: unknown): boolean {
  return replicaRecoveryConflictSqlstate(error) !== undefined;
}

// Reads only. A replica can't run writes, and retrying one would be wrong if it could.
const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "$queryRaw",
  "$queryRawUnsafe",
]);

/** The read a recovery conflict cancelled. */
export type ReplicaRecoveryConflictInfo = {
  model: string | undefined;
  operation: string;
  sqlstate: string | undefined;
};

export type ReplicaRecoveryConflictRetryOptions = {
  /** Total attempts including the first. */
  maxAttempts: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Shared across every client it wraps, so a long conflict burst can't multiply replica load. */
  budget?: RetryBudget;
  onRetry?: (info: ReplicaRecoveryConflictInfo & { attempt: number; delayMs: number }) => void;
  /** A recovery-conflict cancellation surfaced without a retry because `budget` was empty. */
  onBudgetExhausted?: (info: ReplicaRecoveryConflictInfo) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type ExtendableClient = { $extends: (extension: any) => unknown };

/**
 * Wraps a read-replica Prisma client so a read the standby cancels with a recovery conflict is
 * retried after a short jittered delay, up to `maxAttempts`, then the last error surfaces. Only read
 * operations outside a transaction are retried; anything else runs once, unchanged.
 *
 * Apply it after the client's other extensions (Prisma runs the first-added extension outermost), so
 * they (tracing, error logging) see one call and its final outcome, and before
 * `markReadReplicaClient`, since `$extends` returns a new object that would not carry the brand.
 */
export function withReplicaRecoveryConflictRetry<T extends ExtendableClient>(
  client: T,
  options: ReplicaRecoveryConflictRetryOptions
): T {
  return client.$extends({
    name: "replica-recovery-conflict-retry",
    query: {
      $allOperations: async (params: {
        model?: string;
        operation: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
        // Not in Prisma's public types. Set when the call runs inside an interactive or batch
        // transaction, where one statement can't be re-run on its own. The "not retried" transaction
        // tests in replicaRecoveryConflictRetry.test.ts fail if a Prisma upgrade renames it.
        __internalParams?: { transaction?: unknown };
      }) => {
        const { model, operation, args, query } = params;
        if (!READ_OPERATIONS.has(operation) || params.__internalParams?.transaction) {
          return query(args);
        }

        // Each query(args) call re-wraps Prisma's customDataProxyFetch hook. That's a no-op unless
        // an Accelerate-style extension sets the hook on this client.
        //
        // withInfraRetry asks the budget only after isRetryable accepted the error, so the sqlstate
        // recorded there belongs to the cancellation the budget is refusing.
        let sqlstate: string | undefined;
        const { budget } = options;
        return withInfraRetry(() => query(args), {
          options: {
            enabled: true,
            maxAttempts: options.maxAttempts,
            backoffMinMs: options.backoffMinMs,
            backoffMaxMs: options.backoffMaxMs,
          },
          budget: budget && {
            tryConsume: () => {
              if (budget.tryConsume()) {
                return true;
              }
              options.onBudgetExhausted?.({ model, operation, sqlstate });
              return false;
            },
          },
          isRetryable: (error) => {
            sqlstate = replicaRecoveryConflictSqlstate(error);
            return sqlstate !== undefined;
          },
          sleep: options.sleep,
          random: options.random,
          onRetry: ({ attempt, delayMs }) =>
            options.onRetry?.({ model, operation, attempt, delayMs, sqlstate }),
        });
      },
    },
  }) as T;
}
