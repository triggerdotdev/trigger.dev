/**
 * Which organizations this browser has seen agent watches in. This is an accelerator, not the
 * gate: a watch created in this tab starts the poll without a reload. The ungated signals are the
 * unread count and the active-watch flag the page load carries — see {@link shouldPollWakeFeed}.
 * Shared through `localStorage`, so a watch created in one tab wakes the others.
 */

const STORAGE_KEY = "tdev:dashboard-agent:watching";

// Newest ids only, so the key can't grow unbounded.
const MAX_REMEMBERED = 10;

const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything else under this key is another writer's; keep only what we can compare.
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
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

/**
 * Whether this browser should poll the wake feed. Both server signals come from the page load,
 * so a fresh browser polls without ever opening the panel: `serverUnreadWakes` for a wake that
 * already landed, `serverHasActiveWatches` for one created elsewhere that hasn't fired yet.
 */
export function shouldPollWakeFeed(params: {
  serverUnreadWakes: number;
  serverHasActiveWatches?: boolean;
  /** Chats holding work their owner hasn't seen, as the page load counted them. */
  serverUnreadWork?: number;
  /** This tab sent a turn that may still be running behind a closed panel. */
  turnInFlight?: boolean;
  organizationId: string;
}): boolean {
  return (
    params.serverUnreadWakes > 0 ||
    params.serverHasActiveWatches === true ||
    (params.serverUnreadWork ?? 0) > 0 ||
    params.turnInFlight === true ||
    hasWatchActivity(params.organizationId)
  );
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
