import { compareDeploymentVersions } from "../isomorphic/deploymentVersions.js";

/**
 * Signals: a small message sent to an environment. Every executing run in that environment that
 * listens for the signal's name receives it. Unstable: the surface may change before release.
 */

/** Names are 1 to 128 characters of letters, digits and `.`, `_`, `-`, `:`, starting with a letter or digit. */
const SIGNAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Names starting with this are sent by the platform only. */
export const RESERVED_SIGNAL_PREFIX = "trigger.";
/** The largest payload a send accepts, as JSON. */
export const SIGNAL_PAYLOAD_MAX_BYTES = 1024;
/**
 * How many (name, task) pairs an environment can hold a latest signal for (the platform's own
 * names aren't counted). Every record on the environment's signal stream carries the latest of
 * each, so the number stays small. A send of a new pair when full is refused; `unstable_signals.clear`
 * frees one.
 */
export const MAX_SIGNAL_KEYS = 32;

/**
 * The signal the platform sends when an environment's skew protection thresholds change: set,
 * cleared, or changed by a promote or rollback. Its payload is a
 * {@link SkewProtectionThresholdSignalPayload}. Chat agents with `versionSkew: "follow-mid-turn"`
 * listen for it while a turn runs.
 */
export const SKEW_PROTECTION_THRESHOLD_SIGNAL = "trigger.skew-protection-threshold";

/**
 * The environment's skew protection thresholds, as versions. Empty when none is set.
 * `midTurnTasks` lists the tasks whose current deployment can continue a turn handed to it; a
 * running turn of any other task finishes on its version.
 */
export type SkewProtectionThresholdSignalPayload = {
  environment?: string;
  tasks?: Record<string, string>;
  midTurnTasks?: string[];
};

/**
 * The threshold a running turn of `task` must move off, from a
 * {@link SKEW_PROTECTION_THRESHOLD_SIGNAL} payload: the higher of the environment's threshold and
 * the task's own (the same rule as a session's version floor), or undefined when none applies or
 * the task isn't in `midTurnTasks`. Lenient: anything malformed reads as no threshold.
 */
export function skewProtectionThresholdForTask(payload: unknown, task: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const state = payload as Record<string, unknown>;
  if (!Array.isArray(state.midTurnTasks) || !state.midTurnTasks.includes(task)) return undefined;
  const environment = typeof state.environment === "string" ? state.environment : undefined;
  const tasks =
    state.tasks && typeof state.tasks === "object" ? (state.tasks as Record<string, unknown>) : {};
  const own =
    Object.hasOwn(tasks, task) && typeof tasks[task] === "string" ? tasks[task] : undefined;
  if (!own) return environment;
  if (!environment) return own;
  return compareDeploymentVersions(own, environment) > 0 ? own : environment;
}

/**
 * Why `name` can't be used, or undefined when it can. Names starting with
 * {@link RESERVED_SIGNAL_PREFIX} are refused unless `allowReserved` (listening, and the
 * platform's own sends).
 */
export function signalNameError(
  name: string,
  options?: { allowReserved?: boolean }
): string | undefined {
  if (!SIGNAL_NAME_PATTERN.test(name)) {
    return `"${name.slice(0, 140)}" isn't a signal name: use 1 to 128 letters, digits, ".", "_", "-" or ":", starting with a letter or digit.`;
  }
  if (!options?.allowReserved && name.startsWith(RESERVED_SIGNAL_PREFIX)) {
    return `Signal names starting with "${RESERVED_SIGNAL_PREFIX}" are reserved.`;
  }
  return undefined;
}

/** Why `payload` is too large to send, or undefined when it isn't. */
export function signalPayloadError(
  payload: unknown,
  maxBytes: number = SIGNAL_PAYLOAD_MAX_BYTES
): string | undefined {
  const size = new TextEncoder().encode(JSON.stringify(payload ?? null)).byteLength;
  return size > maxBytes
    ? `A signal payload is at most ${maxBytes} bytes as JSON (got ${size}).`
    : undefined;
}

/** One entry of a signal record's latest map, as stored on the environment's signal stream. */
export type SignalEntry = {
  name: string;
  /** Only runs of this task receive it. Absent: every listening run. */
  task?: string;
  payload: unknown;
  /** ISO 8601. */
  sentAt: string;
  /** The stream position of the record that sent it. Later sends have higher numbers. */
  seq: number;
  /**
   * Identifies the send. A basin move carries the entry to a new stream under a new seq and keeps
   * this, so a listener that already had it doesn't get it again. Absent on older entries.
   */
  id?: string;
};

/**
 * The body of every record on an environment's signal stream: the name just sent and the latest
 * signal of every (name, task) pair, that one included. A listener starts at the last record, so
 * its first record already holds the latest of each name.
 */
export type SignalRecord = {
  name: string;
  latest: SignalEntry[];
};

/** What a listener receives. */
export type Signal<TPayload = unknown> = {
  name: string;
  payload: TPayload;
  /** Set when the signal was sent to one task's runs. */
  task?: string;
  sentAt: Date;
  seq: number;
};

export type SignalHandler<TPayload = unknown> = (signal: Signal<TPayload>) => void;

export interface SignalsManager {
  /**
   * Listen for a signal by name while this run executes. The latest one sent before the call (if
   * any) is delivered first, then each new one. Returns a function that stops listening.
   */
  on(name: string, handler: SignalHandler): () => void;
  /** Stop every listener and close the subscription. Called between runs. */
  reset(): void;
}

export function signalEntryKey(entry: { name: string; task?: string }): string {
  return entry.task === undefined ? entry.name : `${entry.name}\u0000${entry.task}`;
}

/** Parse a record's data. Anything else on the stream (malformed or foreign) is ignored. */
export function parseSignalRecord(data: unknown): SignalRecord | undefined {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<SignalRecord>;
  if (typeof record.name !== "string" || !Array.isArray(record.latest)) return undefined;
  const latest = record.latest.filter(
    (entry): entry is SignalEntry =>
      !!entry &&
      typeof entry === "object" &&
      typeof entry.name === "string" &&
      typeof entry.seq === "number" &&
      typeof entry.sentAt === "string" &&
      (entry.task === undefined || typeof entry.task === "string") &&
      (entry.id === undefined || typeof entry.id === "string")
  );
  return { name: record.name, latest };
}
