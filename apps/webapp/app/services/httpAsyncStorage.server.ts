import type { AuditLogContext } from "@trigger.dev/plugins";
import { AsyncLocalStorage } from "node:async_hooks";

/** Who made the request and how, as the auth functions learned it. Never a credential value. */
export type RequestAuditIdentity = Pick<
  AuditLogContext,
  "actor" | "credential" | "onBehalfOf" | "source" | "endpoint" | "origin"
> & {
  /**
   * Looks up the credential's fingerprint id the first time an event asks for it; later calls in
   * the same request share that lookup. Absent when the credential needs none. Null when none was
   * found or the lookup failed; undefined without the audit log plugin.
   */
  lookUpCredentialFingerprint?: () => Promise<string | null | undefined>;
};

export type HttpLocalStorage = {
  requestId: string;
  path: string;
  host: string;
  method: string;
  abortController: AbortController;
  /** Destroys the response's connection, for a route that must stop a client that won't read. */
  closeConnection?: () => void;
  /** Set by the auth functions once the caller is authenticated. */
  auditIdentity?: RequestAuditIdentity;
};

const httpLocalStorage = new AsyncLocalStorage<HttpLocalStorage>();

export type RunWithHttpContextFunction = <T>(context: HttpLocalStorage, fn: () => T) => T;

export function runWithHttpContext<T>(context: HttpLocalStorage, fn: () => T): T {
  return httpLocalStorage.run(context, fn);
}

export function getHttpContext(): HttpLocalStorage | undefined {
  return httpLocalStorage.getStore();
}

// Fallback signal that is never aborted, safe for tests and non-Express contexts.
const neverAbortedSignal = new AbortController().signal;

/**
 * Returns an AbortSignal wired to the Express response's "close" event.
 * This bypasses the broken request.signal chain in @remix-run/express
 * (caused by Node.js undici GC bug nodejs/node#55428).
 */
export function getRequestAbortSignal(): AbortSignal {
  return httpLocalStorage.getStore()?.abortController.signal ?? neverAbortedSignal;
}
