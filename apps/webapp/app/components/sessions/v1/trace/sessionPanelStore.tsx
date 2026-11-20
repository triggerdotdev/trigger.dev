import { createContext, useContext, useState, useSyncExternalStore } from "react";
import type { SpanOverride } from "~/v3/eventRepository/eventRepository.types";
import type { RunFacts, RunLoadNote } from "./sessionRunNote";

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
  #facts = new Map<string, RunFacts>();
  #loadNotes = new Map<string, RunLoadNote>();
  #settledRuns = new Set<string>();
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * What the runs route says about runs, and each run's own span id (which opens its run panel and
   * means it's in the run store). Written together, so the panel never sees one without the other.
   * Entries are never removed.
   */
  setRuns(runs: Record<string, { facts: RunFacts; spanId: string | undefined }>) {
    let changed = false;
    for (const [runFriendlyId, { facts, spanId }] of Object.entries(runs)) {
      if (spanId && this.#spanIds.get(runFriendlyId) !== spanId) {
        this.#spanIds.set(runFriendlyId, spanId);
        changed = true;
      }
      if (!sameFacts(this.#facts.get(runFriendlyId), facts)) {
        this.#facts.set(runFriendlyId, facts);
        changed = true;
      }
    }
    if (changed) this.#notify();
  }

  setRunData(runFriendlyId: string, data: RunPanelData | undefined) {
    if (data) this.#runData.set(runFriendlyId, data);
    else if (!this.#runData.delete(runFriendlyId)) return;
    this.#notify();
  }

  /**
   * What reading each run's trace found (deleted logs, can't show here, span limits, failures).
   * Replaces the last set: these belong to the Trace tab's loads.
   */
  setRunLoadNotes(notes: Record<string, RunLoadNote>) {
    let changed = false;
    for (const runFriendlyId of [...this.#loadNotes.keys()]) {
      if (runFriendlyId in notes) continue;
      this.#loadNotes.delete(runFriendlyId);
      changed = true;
    }
    for (const [runFriendlyId, next] of Object.entries(notes)) {
      if (sameLoadNote(this.#loadNotes.get(runFriendlyId), next)) continue;
      this.#loadNotes.set(runFriendlyId, next);
      changed = true;
    }
    if (changed) this.#notify();
  }

  /**
   * Runs whose read in the Trace tab has ended: fully loaded, cut off, failed or can't load.
   * Replaces the last set: these belong to the Trace tab's loads.
   */
  setSettledRuns(runFriendlyIds: ReadonlySet<string>) {
    const same =
      runFriendlyIds.size === this.#settledRuns.size &&
      [...runFriendlyIds].every((id) => this.#settledRuns.has(id));
    if (same) return;
    this.#settledRuns = new Set(runFriendlyIds);
    this.#notify();
  }

  isRunSettled(runFriendlyId: string) {
    return this.#settledRuns.has(runFriendlyId);
  }

  getRunFacts(runFriendlyId: string) {
    return this.#facts.get(runFriendlyId);
  }

  getRunLoadNote(runFriendlyId: string) {
    return this.#loadNotes.get(runFriendlyId);
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

export function useRunSettled(runFriendlyId: string) {
  const store = useSessionPanelStore();
  const read = () => store?.isRunSettled(runFriendlyId) ?? false;
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}

export function useRunNote(runFriendlyId: string) {
  const store = useSessionPanelStore();
  const subscribe = store?.subscribe ?? noSubscribe;
  const readFacts = () => store?.getRunFacts(runFriendlyId);
  const readLoadNote = () => store?.getRunLoadNote(runFriendlyId);
  const facts = useSyncExternalStore(subscribe, readFacts, readFacts);
  const loadNote = useSyncExternalStore(subscribe, readLoadNote, readLoadNote);
  return { facts, loadNote };
}

function sameFacts(a: RunFacts | undefined, b: RunFacts) {
  return (
    a !== undefined &&
    a.number === b.number &&
    a.reason === b.reason &&
    a.afterCrash === b.afterCrash &&
    a.triggeredAt === b.triggeredAt &&
    a.unavailable === b.unavailable
  );
}

// Field by field: the tab sends these on every chunk.
function sameLoadNote(a: RunLoadNote | undefined, b: RunLoadNote) {
  if (a?.kind !== b.kind) return false;
  switch (b.kind) {
    case "logsDeleted":
      return true;
    case "unavailable":
      return a.kind === "unavailable" && a.reason === b.reason;
    case "cutOff":
      return (
        a.kind === "cutOff" &&
        a.started === b.started &&
        a.limit === b.limit &&
        a.spanLimit === b.spanLimit
      );
    case "error":
      return a.kind === "error" && a.message === b.message;
  }
}
