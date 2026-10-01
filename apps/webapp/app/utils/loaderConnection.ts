const RECONNECT_INTERVAL_MS = 5_000;

const failedRequests = new Set<symbol>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeToLoaderConnection(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isLoaderDisconnected() {
  return !window.navigator.onLine || failedRequests.size > 0;
}

function waitForReconnect(signal: AbortSignal | null | undefined) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("online", retry);
      signal?.removeEventListener("abort", abort);
    };
    const retry = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(retry, RECONNECT_INTERVAL_MS);
    window.addEventListener("online", retry);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createLoaderFetch(fetch: typeof window.fetch): typeof window.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), window.location.href);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (
      url.origin !== window.location.origin ||
      !url.searchParams.has("_data") ||
      method !== "GET"
    ) {
      return fetch(input, init);
    }

    const signal = init?.signal ?? request?.signal;
    const token = Symbol("loaderRequest");
    // Keep Remix's loader pending so it retains the mounted page and its data.
    // Never retry mutations: a lost response doesn't mean the write failed.
    try {
      while (true) {
        signal?.throwIfAborted();
        try {
          return await fetch(input, init);
        } catch (error) {
          if (signal?.aborted || !(error instanceof TypeError)) throw error;
          if (!failedRequests.has(token)) {
            failedRequests.add(token);
            notify();
          }
          await waitForReconnect(signal);
        }
      }
    } finally {
      if (failedRequests.delete(token)) notify();
    }
  };
}

export function installLoaderConnectionRecovery() {
  window.fetch = createLoaderFetch(window.fetch.bind(window));
  window.addEventListener("offline", notify);
  window.addEventListener("online", notify);
}
