import { TokenBucketRetryBudget, type TransactionStartRetryConfig } from "@trigger.dev/database";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

/**
 * Resolved transaction-resilience config for one writer pool. Each pool gets its own
 * {@link TransactionStartRetryConfig} (with its OWN token bucket, so a storm on one pool cannot
 * drain another's retry budget) plus the `maxWait` applied when that pool opens a transaction.
 * Env is read here at the app boundary (IoC); the library never reads env.
 *
 * Kept out of `db.server` on purpose: `db.server` is mocked wholesale by ~150 tests, and a new
 * export there breaks every mock that does not list it. Both `db.server` and `runStore.server`
 * import these from here instead.
 */
export type TransactionResilienceConfig = {
  maxWait: number;
  startRetry: TransactionStartRetryConfig;
};

// Exported so the topology singleton can build a per-shard config (each call creates its OWN
// TokenBucketRetryBudget, so one shard's retry storm cannot drain another's). `pool` is a free
// string — it only labels a log line, never keys any behaviour.
export function resolveTransactionResilience(
  pool: string,
  overrides: {
    maxWaitMs?: number;
    enabled?: boolean;
    maxAttempts?: number;
    backoffMinMs?: number;
    backoffMaxMs?: number;
    budgetPerSec?: number;
    budgetBurst?: number;
  }
): TransactionResilienceConfig {
  const budgetPerSec =
    overrides.budgetPerSec ?? env.DATABASE_TRANSACTION_START_RETRY_BUDGET_PER_SEC;
  const budgetBurst = overrides.budgetBurst ?? env.DATABASE_TRANSACTION_START_RETRY_BUDGET_BURST;
  return {
    maxWait: Math.max(0, overrides.maxWaitMs ?? env.DATABASE_TRANSACTION_MAX_WAIT_MS),
    startRetry: {
      options: {
        enabled: overrides.enabled ?? env.DATABASE_TRANSACTION_START_RETRY_ENABLED,
        maxAttempts: overrides.maxAttempts ?? env.DATABASE_TRANSACTION_START_RETRY_MAX_ATTEMPTS,
        backoffMinMs: overrides.backoffMinMs ?? env.DATABASE_TRANSACTION_START_RETRY_BACKOFF_MIN_MS,
        backoffMaxMs: overrides.backoffMaxMs ?? env.DATABASE_TRANSACTION_START_RETRY_BACKOFF_MAX_MS,
      },
      budget: new TokenBucketRetryBudget({ ratePerSec: budgetPerSec, burst: budgetBurst }),
      onRetry: ({ attempt, delayMs }) =>
        logger.warn("retrying transaction start after acquisition failure", {
          pool,
          attempt,
          delayMs,
        }),
    },
  };
}

export const controlPlaneTransactionResilience = resolveTransactionResilience("control-plane", {});

export const runOpsTransactionResilience = resolveTransactionResilience("run-ops", {
  maxWaitMs: env.RUN_OPS_DATABASE_TRANSACTION_MAX_WAIT_MS,
  enabled: env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_ENABLED,
  maxAttempts: env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_MAX_ATTEMPTS,
  backoffMinMs: env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BACKOFF_MIN_MS,
  backoffMaxMs: env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BACKOFF_MAX_MS,
  budgetPerSec: env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BUDGET_PER_SEC,
  budgetBurst: env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BUDGET_BURST,
});

// A gen-2 shard's resilience. Defaults to the RUN_OPS_DATABASE_TRANSACTION_* values (so a shard with
// no overrides matches the gen-1 new store), then applies the descriptor's per-shard overrides. Each
// call builds its OWN budget, so a storm on one shard cannot drain another's.
export function resolveShardResilience(
  key: string,
  overrides?: {
    transactionMaxWaitMs?: number;
    transactionStartRetryEnabled?: boolean;
    transactionStartRetryMaxAttempts?: number;
    transactionStartRetryBackoffMinMs?: number;
    transactionStartRetryBackoffMaxMs?: number;
    transactionStartRetryBudgetPerSec?: number;
    transactionStartRetryBudgetBurst?: number;
  }
): TransactionResilienceConfig {
  return resolveTransactionResilience(`run-ops-shard-${key}`, {
    maxWaitMs: overrides?.transactionMaxWaitMs ?? env.RUN_OPS_DATABASE_TRANSACTION_MAX_WAIT_MS,
    enabled:
      overrides?.transactionStartRetryEnabled ??
      env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_ENABLED,
    maxAttempts:
      overrides?.transactionStartRetryMaxAttempts ??
      env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_MAX_ATTEMPTS,
    backoffMinMs:
      overrides?.transactionStartRetryBackoffMinMs ??
      env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BACKOFF_MIN_MS,
    backoffMaxMs:
      overrides?.transactionStartRetryBackoffMaxMs ??
      env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BACKOFF_MAX_MS,
    budgetPerSec:
      overrides?.transactionStartRetryBudgetPerSec ??
      env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BUDGET_PER_SEC,
    budgetBurst:
      overrides?.transactionStartRetryBudgetBurst ??
      env.RUN_OPS_DATABASE_TRANSACTION_START_RETRY_BUDGET_BURST,
  });
}

export const runOpsLegacyTransactionResilience = resolveTransactionResilience("run-ops-legacy", {
  maxWaitMs: env.RUN_OPS_LEGACY_DATABASE_TRANSACTION_MAX_WAIT_MS,
  enabled: env.RUN_OPS_LEGACY_DATABASE_TRANSACTION_START_RETRY_ENABLED,
  maxAttempts: env.RUN_OPS_LEGACY_DATABASE_TRANSACTION_START_RETRY_MAX_ATTEMPTS,
  backoffMinMs: env.RUN_OPS_LEGACY_DATABASE_TRANSACTION_START_RETRY_BACKOFF_MIN_MS,
  backoffMaxMs: env.RUN_OPS_LEGACY_DATABASE_TRANSACTION_START_RETRY_BACKOFF_MAX_MS,
  budgetPerSec: env.RUN_OPS_LEGACY_DATABASE_TRANSACTION_START_RETRY_BUDGET_PER_SEC,
  budgetBurst: env.RUN_OPS_LEGACY_DATABASE_TRANSACTION_START_RETRY_BUDGET_BURST,
});

const transactionResilienceByClient = new WeakMap<object, TransactionResilienceConfig>();

/**
 * Associate a writer client with its pool's resilience config. Returns the client for inline use at
 * construction. Kept here (not in db.server) so nothing new lands on db.server's wholesale-mocked
 * export surface.
 */
export function registerTransactionResilience<T extends object>(
  client: T,
  resilience: TransactionResilienceConfig
): T {
  transactionResilienceByClient.set(client, resilience);
  return client;
}

/**
 * The resilience config registered for a writer client, or the control-plane config as a safe
 * fallback. Derives resilience from the ACTUAL client identity rather than an assumed routing role,
 * so run-ops clients aliased onto the control-plane pool (split flag off) correctly get the
 * control-plane config instead of a run-ops override.
 */
export function resilienceForClient(client: object): TransactionResilienceConfig {
  return transactionResilienceByClient.get(client) ?? controlPlaneTransactionResilience;
}
