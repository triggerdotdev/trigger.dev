/** At most this many runs fetch their spans at once, first chunk and later pages included. */
export const MAX_CONCURRENT_RUN_LOADS = 3;

type RunTraceUnavailableReason =
  | "legacyStore"
  | "emergencyCap"
  | "chunkUnsupported"
  | "noWriteTimes"
  | "anchorMissing"
  | "noSpans";

type SettledRunLoad =
  | { state: "progressive" }
  | { state: "empty" }
  | { state: "unavailable"; reason: RunTraceUnavailableReason }
  | { state: "logsDeleted" }
  | { state: "error"; message: string };

export type SessionRunLoad =
  | { state: "idle" }
  | { state: "queued" }
  /** `loadId` identifies this fetch; a settle for an older one is ignored. */
  | { state: "loading"; loadId: number }
  /** First chunk shown, later pages still loading; keeps its slot. */
  | { state: "paging"; loadId: number }
  | SettledRunLoad;

/** Where a run's read got to: paging after its first chunk, or how it ended. */
type SessionRunLoadOutcome = { state: "paging" } | SettledRunLoad;

export type SessionRunLoads = {
  loads: Readonly<Record<string, SessionRunLoad>>;
  /** Queued runs in request order. */
  queue: readonly string[];
  nextLoadId: number;
};

export type SessionRunLoadsAction =
  | { type: "request"; runFriendlyIds: string[] }
  | { type: "settle"; runFriendlyId: string; loadId: number; outcome: SessionRunLoadOutcome }
  | { type: "release"; runFriendlyIds: string[] };

const IDLE: SessionRunLoad = { state: "idle" };
const REQUESTABLE = new Set<SessionRunLoad["state"]>(["idle", "error", "empty"]);

function isInFlight(load: SessionRunLoad): load is Extract<SessionRunLoad, { loadId: number }> {
  return load.state === "loading" || load.state === "paging";
}

export const initialSessionRunLoads: SessionRunLoads = { loads: {}, queue: [], nextLoadId: 1 };

export function runLoad(loads: SessionRunLoads, runFriendlyId: string): SessionRunLoad {
  return loads.loads[runFriendlyId] ?? IDLE;
}

/**
 * Requested runs queue up and start loading as slots free, oldest request first. A run holds its
 * slot until all its pages are in. Only idle, failed and empty runs can be requested. Release
 * puts runs back to idle and frees their slot, cancelling a fetch in flight: its late settle no
 * longer matches the run's load id.
 */
export function sessionRunLoadsReducer(
  current: SessionRunLoads,
  action: SessionRunLoadsAction
): SessionRunLoads {
  switch (action.type) {
    case "request": {
      const requested = [...new Set(action.runFriendlyIds)].filter((id) =>
        REQUESTABLE.has(runLoad(current, id).state)
      );
      if (requested.length === 0) return current;

      const loads = { ...current.loads };
      for (const id of requested) loads[id] = { state: "queued" };
      return startQueued({ ...current, loads, queue: [...current.queue, ...requested] });
    }
    case "settle": {
      const load = runLoad(current, action.runFriendlyId);
      if (!isInFlight(load) || load.loadId !== action.loadId) return current;

      const next: SessionRunLoad =
        action.outcome.state === "paging"
          ? { state: "paging", loadId: load.loadId }
          : action.outcome;
      return startQueued({
        ...current,
        loads: { ...current.loads, [action.runFriendlyId]: next },
      });
    }
    case "release": {
      const released = new Set(action.runFriendlyIds.filter((id) => id in current.loads));
      if (released.size === 0) return current;

      const loads = { ...current.loads };
      for (const id of released) delete loads[id];
      return startQueued({
        ...current,
        loads,
        queue: current.queue.filter((id) => !released.has(id)),
      });
    }
  }
}

function startQueued(current: SessionRunLoads): SessionRunLoads {
  let inFlight = Object.values(current.loads).filter(isInFlight).length;
  if (inFlight >= MAX_CONCURRENT_RUN_LOADS || current.queue.length === 0) return current;

  const loads = { ...current.loads };
  const queue = [...current.queue];
  let nextLoadId = current.nextLoadId;
  while (inFlight < MAX_CONCURRENT_RUN_LOADS) {
    const id = queue.shift();
    if (!id) break;
    loads[id] = { state: "loading", loadId: nextLoadId++ };
    inFlight++;
  }
  return { loads, queue, nextLoadId };
}
