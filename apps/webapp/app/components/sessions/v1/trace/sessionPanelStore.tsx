import { createContext, useContext, useState, useSyncExternalStore } from "react";
import type { SpanOverride } from "~/v3/eventRepository/eventRepository.types";

/** What the side panel needs from a run's loaded trace. */
export type RunPanelData = {
  refreshKey: number | undefined;
  overridesBySpanId: Record<string, SpanOverride> | undefined;
  linkedRunIdBySpanId: Record<string, string> | undefined;
};

/**
 * Hands run data from the Trace tab to the side panel, its sibling. Each reader subscribes to
 * one run, so live spans on other runs don't re-render the panel.
 */
class SessionPanelStore {
  #spanIds = new Map<string, string>();
  #runData = new Map<string, RunPanelData>();
  #confirmedSpans = new Set<string>();
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** A run's own span id, which opens its run panel. Ids are never removed. */
  setRunSpanIds(spanIds: Record<string, { spanId: string }>) {
    let changed = false;
    for (const [runFriendlyId, { spanId }] of Object.entries(spanIds)) {
      if (this.#spanIds.get(runFriendlyId) === spanId) continue;
      this.#spanIds.set(runFriendlyId, spanId);
      changed = true;
    }
    if (changed) this.#notify();
  }

  setRunData(runFriendlyId: string, data: RunPanelData | undefined) {
    if (data) this.#runData.set(runFriendlyId, data);
    else if (!this.#runData.delete(runFriendlyId)) return;
    this.#notify();
  }

  /**
   * A span the tree has seen in its run's trace. The span route sends a missing span to the run
   * page, so the Trace tab only opens a span panel once the span is known to exist.
   */
  confirmSpan(runFriendlyId: string, spanId: string) {
    const key = `${runFriendlyId}:${spanId}`;
    if (this.#confirmedSpans.has(key)) return;
    this.#confirmedSpans.add(key);
    this.#notify();
  }

  isSpanConfirmed(runFriendlyId: string, spanId: string) {
    return this.#confirmedSpans.has(`${runFriendlyId}:${spanId}`);
  }

  getRunSpanId(runFriendlyId: string) {
    return this.#spanIds.get(runFriendlyId);
  }

  getRunData(runFriendlyId: string) {
    return this.#runData.get(runFriendlyId);
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }
}

const SessionPanelStoreContext = createContext<SessionPanelStore | undefined>(undefined);

export function SessionPanelStoreProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => new SessionPanelStore());
  return (
    <SessionPanelStoreContext.Provider value={store}>{children}</SessionPanelStoreContext.Provider>
  );
}

/** Undefined outside the provider, e.g. on the flag-off page. */
export function useSessionPanelStore() {
  return useContext(SessionPanelStoreContext);
}

const noSubscribe = () => () => {};

export function useRunSpanId(runFriendlyId: string | undefined) {
  const store = useSessionPanelStore();
  const read = () => (store && runFriendlyId ? store.getRunSpanId(runFriendlyId) : undefined);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}

export function useRunPanelData(runFriendlyId: string | undefined) {
  const store = useSessionPanelStore();
  const read = () => (store && runFriendlyId ? store.getRunData(runFriendlyId) : undefined);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}

export function useSpanConfirmed(runFriendlyId: string, spanId: string | undefined) {
  const store = useSessionPanelStore();
  const read = () => (store && spanId ? store.isSpanConfirmed(runFriendlyId, spanId) : false);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}
