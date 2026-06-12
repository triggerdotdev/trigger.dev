import { Prisma } from "@trigger.dev/database";

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
