import type { PrismaClient } from "../generated/prisma";
import { Decimal } from "decimal.js";
import type { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

// Define the isolation levels manually
type TransactionIsolationLevel =
  | "ReadUncommitted"
  | "ReadCommitted"
  | "RepeatableRead"
  | "Serializable";

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type PrismaClientOrTransaction = PrismaClient | PrismaTransactionClient;

export type PrismaReplicaClient = Omit<PrismaClient, "$transaction">;

// Narrow client views for the webhook feature's tables, prepping it to run on a
// dedicated Postgres: control-plane models are absent, so touching one on the
// webhook client (or spanning both DBs in a $transaction) is a compile error.
export type WebhookDatabase = Pick<
  PrismaClient,
  | "webhookEndpoint"
  | "webhookDelivery"
  | "$transaction"
  | "$queryRaw"
  | "$queryRawUnsafe"
  | "$executeRaw"
  | "$executeRawUnsafe"
>;

export type WebhookReplicaDatabase = Pick<
  PrismaReplicaClient,
  "webhookEndpoint" | "webhookDelivery" | "$queryRaw" | "$queryRawUnsafe"
>;

export { Decimal };

function isTransactionClient(prisma: PrismaClientOrTransaction): prisma is PrismaTransactionClient {
  return !("$transaction" in prisma);
}

export function isPrismaKnownError(error: unknown): error is PrismaClientKnownRequestError {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

/*
•	P2024: Connection timeout errors
•	P2028: Transaction timeout errors
•	P2034: Transaction deadlock/conflict errors
*/
const retryCodes = ["P2024", "P2028", "P2034"];

const ADAPTER_ACQUIRE_TIMEOUT = /timeout exceeded when trying to connect/i;

export function isPrismaRetriableError(error: unknown): boolean {
  if (isPrismaKnownError(error) && retryCodes.includes(error.code)) {
    return true;
  }

  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" && ADAPTER_ACQUIRE_TIMEOUT.test(message);
}

/*
•	P2025: Record not found errors (in race conditions) [not included for now]
*/
export function isPrismaRaceConditionError(error: unknown): boolean {
  if (!isPrismaKnownError(error)) {
    return false;
  }

  return error.code === "P2025";
}

const TRANSACTION_ACQUISITION_MESSAGE = /Unable to start a transaction in the given time/i;

/**
 * True for a connection-acquisition failure raised BEFORE any SQL ran, so there
 * is nothing to undo and retrying it is safe. Two shapes:
 *   - the default engine's P2028 "Unable to start a transaction in the given time"
 *     (couldn't borrow a connection within `maxWait`), and
 *   - the pg driver adapter's "timeout exceeded when trying to connect" (the pg
 *     Pool couldn't hand out a connection within `connectionTimeoutMillis`).
 * Deliberately narrower than {@link isPrismaRetriableError}: it excludes P2024
 * (pool exhausted) and P2028s raised from inside a running transaction. Callers
 * additionally gate retries on the transaction callback not having entered, so a
 * same-shaped error from a nested transaction never re-runs a side-effectful body.
 */
export function isTransactionAcquisitionError(error: unknown): boolean {
  const message = (error as { message?: unknown })?.message;

  if (isPrismaKnownError(error) && error.code === "P2028") {
    return typeof message === "string" && TRANSACTION_ACQUISITION_MESSAGE.test(message);
  }

  return typeof message === "string" && ADAPTER_ACQUIRE_TIMEOUT.test(message);
}

/** Retry tuning for transaction-start (P2028-at-acquisition) failures. */
export type TransactionStartRetryOptions = {
  /** Kill switch. When false, {@link withTransactionStartRetry} runs the thunk once. */
  enabled: boolean;
  /** Total attempts including the first. `1` (or less) disables retrying. */
  maxAttempts: number;
  /** Lower bound of the jittered backoff between attempts, in ms. */
  backoffMinMs: number;
  /** Upper bound of the jittered backoff between attempts, in ms. */
  backoffMaxMs: number;
};

/**
 * A shared rate limiter so a mass freeze (every request failing tx-start at
 * once) cannot amplify into a retry storm. One instance is shared across all
 * retrying call sites; `tryConsume` returns false when the budget is spent.
 */
export interface RetryBudget {
  tryConsume(): boolean;
}

/** Budget that never denies — the default when a caller supplies no budget. */
export const UNLIMITED_RETRY_BUDGET: RetryBudget = { tryConsume: () => true };

/**
 * Token-bucket {@link RetryBudget}: refills at `ratePerSec` tokens/second up to
 * `burst`, one token per retry. `now` is injectable for tests.
 */
export class TokenBucketRetryBudget implements RetryBudget {
  #tokens: number;
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  #lastRefillAt: number;

  constructor(options: { ratePerSec: number; burst: number; now?: () => number }) {
    this.#capacity = Math.max(0, options.burst);
    this.#refillPerMs = Math.max(0, options.ratePerSec) / 1000;
    this.#now = options.now ?? Date.now;
    this.#tokens = this.#capacity;
    this.#lastRefillAt = this.#now();
  }

  tryConsume(): boolean {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#lastRefillAt);
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
      this.#lastRefillAt = now;
    }
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }
}

export type TransactionStartRetryConfig = {
  options: TransactionStartRetryOptions;
  /** Shared budget; defaults to {@link UNLIMITED_RETRY_BUDGET} when omitted. */
  budget?: RetryBudget;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; returns [0, 1). */
  random?: () => number;
  /** Observability hook fired just before each backoff sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `run` and, ONLY when it throws a P2028-at-acquisition error
 * ({@link isTransactionAcquisitionError}), retries it up to
 * `options.maxAttempts` total attempts with jittered backoff, gated by the
 * shared `budget`. Any other error (and an exhausted budget) rethrows
 * immediately. When retrying is disabled the thunk runs exactly once.
 */
export async function withTransactionStartRetry<R>(
  run: () => Promise<R>,
  config?: TransactionStartRetryConfig,
  canRetry?: () => boolean
): Promise<R> {
  if (!config || !config.options.enabled || config.options.maxAttempts <= 1) {
    return run();
  }

  const { maxAttempts, backoffMinMs, backoffMaxMs } = config.options;
  const budget = config.budget ?? UNLIMITED_RETRY_BUDGET;
  const sleep = config.sleep ?? defaultSleep;
  const random = config.random ?? Math.random;

  let attempt = 1;
  while (true) {
    try {
      return await run();
    } catch (error) {
      if (
        attempt >= maxAttempts ||
        (canRetry !== undefined && !canRetry()) ||
        !isTransactionAcquisitionError(error) ||
        !budget.tryConsume()
      ) {
        throw error;
      }
      const low = Math.max(0, Math.min(backoffMinMs, backoffMaxMs));
      const high = Math.max(low, backoffMaxMs);
      const delayMs = Math.round(low + random() * (high - low));
      config.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

export type PrismaTransactionOptions = {
  /** The maximum amount of time (in ms) Prisma Client will wait to acquire a transaction from the database. The default value is 2000ms. */
  maxWait?: number;

  /** The maximum amount of time (in ms) the interactive transaction can run before being canceled and rolled back. The default value is 5000ms. */
  timeout?: number;

  /**  Sets the transaction isolation level. By default this is set to the value currently configured in your database. */
  isolationLevel?: TransactionIsolationLevel;

  swallowPrismaErrors?: boolean;

  /**
   * The maximum number of times the transaction will be retried in case of a serialization failure. The default value is 0.
   *
   * See https://www.prisma.io/docs/orm/prisma-client/queries/transactions#transaction-timing-issues
   */
  maxRetries?: number;

  /**
   * When set, retry a transaction START that fails with P2028-at-acquisition
   * (see {@link withTransactionStartRetry}). Config is threaded in from the app
   * boundary (IoC); this library never reads env. Only wraps the top-level
   * attempt, so it never nests with the `maxRetries` serialization retry.
   */
  startRetry?: TransactionStartRetryConfig;
};

export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  fn: (prisma: PrismaTransactionClient) => Promise<R>,
  prismaError: (error: PrismaClientKnownRequestError) => void,
  options?: PrismaTransactionOptions,
  attempt = 0
): Promise<R | undefined> {
  if (isTransactionClient(prisma)) {
    return fn(prisma);
  }

  const startRetry = attempt === 0 ? options?.startRetry : undefined;
  const startRetryActive =
    !!startRetry && startRetry.options.enabled && startRetry.options.maxAttempts > 1;

  let entered = false;
  try {
    return await withTransactionStartRetry(
      () =>
        (prisma as PrismaClient).$transaction((tx) => {
          entered = true;
          return fn(tx as PrismaTransactionClient);
        }, options),
      startRetry,
      () => !entered
    );
  } catch (error) {
    if (
      isPrismaRetriableError(error) &&
      !(startRetryActive && isTransactionAcquisitionError(error)) &&
      typeof options?.maxRetries === "number" &&
      attempt < options.maxRetries
    ) {
      return $transaction(prisma, fn, prismaError, options, attempt + 1);
    }

    if (isPrismaKnownError(error)) {
      prismaError(error);

      if (options?.swallowPrismaErrors) {
        return;
      }
    }

    throw error;
  }
}

export function isUniqueConstraintError<T extends readonly string[]>(
  error: unknown,
  columns: T
): boolean {
  if (!isPrismaKnownError(error)) {
    return false;
  }

  if (error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;

  if (!Array.isArray(target)) {
    return false;
  }

  if (target.length !== columns.length) {
    return false;
  }

  for (let i = 0; i < columns.length; i++) {
    if (target[i] !== columns[i]) {
      return false;
    }
  }

  return true;
}
