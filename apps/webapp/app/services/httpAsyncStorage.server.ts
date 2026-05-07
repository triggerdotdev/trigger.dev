import { AsyncLocalStorage } from "node:async_hooks";

export type HttpLocalStorage = {
  requestId: string;
  path: string;
  host: string;
  method: string;
  abortController: AbortController;
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
