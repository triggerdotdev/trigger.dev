/**
 * Which organizations this browser has seen agent watches in. The wake feed costs a request per
 * open tab per minute, so only a browser that knows a watch exists polls it — and once it knows,
 * it keeps polling. Shared through `localStorage`, so a watch created in one tab wakes the others.
 */

const STORAGE_KEY = "tdev:dashboard-agent:watching";

// Newest ids only, so the key can't grow unbounded.
const MAX_REMEMBERED = 10;

const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    // Storage unavailable; treated as "nothing known yet".
    return [];
  }
}

export function hasWatchActivity(organizationId: string): boolean {
  if (typeof window === "undefined") return false;
  return read().includes(organizationId);
}

/** Called whenever a watch shows up for this org: the poll starts from here. */
export function rememberWatchActivity(organizationId: string): void {
  if (typeof window === "undefined" || hasWatchActivity(organizationId)) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...read(), organizationId].slice(-MAX_REMEMBERED))
    );
  } catch {
    // Same as the read. This tab still starts polling for the rest of the session.
  }
  for (const listener of listeners) listener();
}

/**
 * Called when nothing is left to be woken about. The current tab keeps polling for the rest of
 * the session; the next reload starts quiet.
 */
export function forgetWatchActivity(organizationId: string): void {
  if (typeof window === "undefined" || !hasWatchActivity(organizationId)) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(read().filter((id) => id !== organizationId))
    );
  } catch {
    // Same as the read.
  }
}

/** Fires when this browser learns of a watch, in this tab or — via `storage` — in another one. */
export function subscribeWatchActivity(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
