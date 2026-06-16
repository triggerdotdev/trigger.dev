import { Prisma, type PrismaClient, isPrismaKnownError } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";

// Minimal structural logger so this stays decoupled from the concrete Logger
// (and lets tests pass a capturing logger).
type ErrorLogger = { error: (message: string, fields?: Record<string, unknown>) => void };

// Prisma connectivity / infrastructure error codes — engine- and
// connection-level failures, not query- or validation-level ones. When the
// database is unreachable, Prisma 6.x throws a PrismaClientKnownRequestError
// carrying one of these codes (e.g. P1001 "Can't reach database server").
const INFRASTRUCTURE_PRISMA_CODES = new Set([
  "P1001", // Can't reach database server
  "P1002", // Database server reached but timed out
  "P1008", // Operations timed out
  "P1017", // Server has closed the connection
]);

/**
 * True when `error` is a Prisma infrastructure/connectivity failure (DB
 * unreachable, timed out, connection dropped) rather than a query- or
 * validation-level error.
 *
 * These errors carry internal infrastructure detail (e.g. the database
 * hostname) in their `.message`, so they must never be surfaced to API
 * clients — callers should let them propagate to the generic 5xx handler
 * (which both scrubs the message and is retryable by the SDK) instead of
 * folding `.message` into a client-facing error.
 */
export function isInfrastructureError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return INFRASTRUCTURE_PRISMA_CODES.has(error.code);
  }

  return false;
}

// One-shot marker so a single infra error is logged exactly once: the client
// extension (statement level) tags it, and the $transaction-boundary loggers
// skip a tagged error rather than logging the same failure a second time.
const INFRA_ERROR_LOGGED: unique symbol = Symbol("prismaInfraErrorLogged");

function markInfraErrorLogged(error: unknown): void {
  if (typeof error !== "object" || error === null) {
    return;
  }
  try {
    // Non-enumerable so error-spreads/serializers can't copy the marker onto a
    // different error; try/catch so a frozen error object can't make this throw
    // and mask the original error as it propagates out of the catch.
    Object.defineProperty(error, INFRA_ERROR_LOGGED, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // best-effort: a sealed/frozen error simply won't be deduped.
  }
}

export function infraErrorAlreadyLogged(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[INFRA_ERROR_LOGGED] === true
  );
}

// Logs infrastructure failures (P1xxx-class, see isInfrastructureError) and
// rethrows the ORIGINAL error: callers branch on error.code, and this fires
// per-statement inside transactions, so converting it would break that.
export function captureInfrastructureErrors<T extends PrismaClient>(
  client: T,
  log: ErrorLogger = logger
): T {
  return client.$extends({
    name: "infrastructure-error-capture",
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        try {
          return await query(args);
        } catch (error) {
          if (isInfrastructureError(error)) {
            log.error("prisma infrastructure error", {
              model,
              operation,
              code: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
              meta: error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined,
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
            markInfraErrorLogged(error);
          }

          throw error;
        }
      },
    },
  }) as unknown as T;
}

// Logs infrastructure errors that reach the $transaction boundary WITHOUT a
// Prisma error code (e.g. PrismaClientInitializationError). Coded errors there
// are already logged by transac()'s callback, and errors that bubbled up from a
// statement were already logged (and tagged) by the client extension — both are
// skipped here to avoid double-logging. Returns whether it logged.
export function logTransactionInfrastructureError(
  error: unknown,
  log: ErrorLogger = logger
): boolean {
  if (!isInfrastructureError(error) || isPrismaKnownError(error) || infraErrorAlreadyLogged(error)) {
    return false;
  }

  log.error("prisma.$transaction infrastructure error", {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  });

  return true;
}

// Replaces a Prisma infrastructure error's message (which carries the DB
// hostname) with a generic one before it reaches an API client. Any other
// error's message is returned unchanged. Status codes/headers are unaffected.
export function clientSafeErrorMessage(error: Error): string {
  return isInfrastructureError(error) ? "Internal Server Error" : error.message;
}
