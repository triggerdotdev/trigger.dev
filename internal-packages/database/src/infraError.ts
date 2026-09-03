import { Prisma } from "../generated/prisma";

// Prisma connectivity / infrastructure error codes — connection-level failures,
// not query- or validation-level ones (e.g. P1001 "Can't reach database server").
const INFRASTRUCTURE_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);

const CONNECTIVITY_ERRNO = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
]);

const CONNECTIVITY_MESSAGE =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|database not reachable|can't reach database|connection terminated|terminating connection|server has closed the connection|client has encountered a connection error|timed out fetching a new connection/i;

// Connection-pool exhaustion (P2024). Matched only to EXCLUDE it from retry:
// retrying against an already-exhausted pool deepens the contention rather than
// riding out a blip (the transaction-start retry gate excludes it for the same reason).
const POOL_EXHAUSTION_MESSAGE = /timed out fetching a new connection/i;

/** True for an errno/message that looks like a lost or unreachable connection. */
export function looksLikeConnectivityError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  if (typeof e?.code === "string" && CONNECTIVITY_ERRNO.has(e.code)) {
    return true;
  }
  return typeof e?.message === "string" && CONNECTIVITY_MESSAGE.test(e.message);
}

/**
 * True when `error` is a Prisma infrastructure/connectivity failure (DB
 * unreachable, timed out, connection dropped) rather than a query- or
 * validation-level error. Broad by design (matches the classifier used for
 * logging); for the retry decision use {@link isRetryableInfrastructureError}.
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
    if (INFRASTRUCTURE_PRISMA_CODES.has(error.code)) {
      return true;
    }
    return error.code === "P2010" && looksLikeConnectivityError(error);
  }

  return looksLikeConnectivityError(error);
}

/**
 * True when `error` is a *transient* infrastructure failure worth retrying — a
 * genuine connectivity blip, not a permanent one. Narrower than
 * {@link isInfrastructureError}: an initialization or unknown-request error
 * counts only when it carries a connectivity signal (so a bad-URL / auth /
 * database-selection failure is NOT retried), and a Rust-engine panic is never
 * retried. This is the default retry gate for `withInfraRetry`.
 */
export function isRetryableInfrastructureError(error: unknown): boolean {
  // Recognise the Prisma error TYPE by name, not `instanceof`: the run-ops client is a separately
  // generated Prisma runtime, so its error classes are not the control-plane `Prisma.*` classes an
  // `instanceof` here would test. A run-ops panic (or any run-ops error) must be classified by the
  // same rules, or a foreign panic with a connectivity-ish message would fall through as retryable.
  const name = (error as { name?: unknown })?.name;
  const code = (error as { code?: unknown })?.code;
  const message = (error as { message?: unknown })?.message;

  // Never retry pool exhaustion (P2024): another attempt only competes for the
  // same exhausted pool. Checked before the connectivity fallbacks because its
  // message otherwise matches CONNECTIVITY_MESSAGE.
  if (
    (name === "PrismaClientKnownRequestError" && code === "P2024") ||
    (typeof message === "string" && POOL_EXHAUSTION_MESSAGE.test(message))
  ) {
    return false;
  }

  // Never retry a Rust-engine panic, from EITHER generated runtime.
  if (name === "PrismaClientRustPanicError") {
    return false;
  }

  if (name === "PrismaClientInitializationError") {
    const errorCode = (error as { errorCode?: unknown })?.errorCode;
    return (
      (typeof errorCode === "string" && INFRASTRUCTURE_PRISMA_CODES.has(errorCode)) ||
      looksLikeConnectivityError(error)
    );
  }

  if (name === "PrismaClientUnknownRequestError") {
    return looksLikeConnectivityError(error);
  }

  if (name === "PrismaClientKnownRequestError") {
    if (typeof code === "string" && INFRASTRUCTURE_PRISMA_CODES.has(code)) {
      return true;
    }
    return code === "P2010" && looksLikeConnectivityError(error);
  }

  return looksLikeConnectivityError(error);
}
