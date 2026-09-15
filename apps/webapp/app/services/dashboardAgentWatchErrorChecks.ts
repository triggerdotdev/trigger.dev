/** The error-recurrence condition family. */

import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import type { WatchObservedOutcome, WatchSpec } from "@internal/dashboard-agent-contracts";
import type {
  WatchCheckDeps,
  WatchCheckInput,
  WatchCheckOutcome,
} from "./dashboardAgentWatchCheckBase";

/**
 * The model cites the API error id (`error_<fingerprint>`) but ClickHouse stores the raw
 * fingerprint. Same normalization the errors API route uses.
 */
export function normalizeErrorFingerprint(fingerprint: string): string {
  return ErrorId.toId(fingerprint);
}

/**
 * Satisfied on the first occurrence proven to be after the server-set `since`, which is
 * never caller-set. The facts carry the precision of what they claim.
 */
export async function checkErrorRecurrence(
  spec: Extract<WatchSpec, { kind: "error_recurrence" }>,
  deps: WatchCheckDeps,
  input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const fingerprint = normalizeErrorFingerprint(spec.fingerprint);
  const recurrence = await deps.readErrorRecurrence(fingerprint, input.since);
  const base = { fingerprint, since: input.since.toISOString() };

  const quiet: WatchObservedOutcome = {
    kind: "error_recurrence",
    verified: true,
    countSince: 0,
  };

  if (!recurrence) {
    return {
      result: "pending",
      facts: { ...base, countSince: 0, lastSeenAt: null },
      observed: quiet,
    };
  }

  const lastSeenAt = recurrence.lastSeenAt?.toISOString() ?? null;

  if (!recurrence.occurredAt) {
    return {
      result: "pending",
      facts: { ...base, countSince: 0, lastSeenAt },
      observed: quiet,
    };
  }

  return {
    result: "satisfied",
    facts: {
      ...base,
      occurredAt: recurrence.occurredAt.toISOString(),
      occurredAtPrecision: recurrence.occurredAtPrecision,
      countSince: recurrence.countSince,
      countApproximate: recurrence.countApproximate,
      lastSeenAt,
    },
    observed: {
      kind: "error_recurrence",
      verified: true,
      countSince: recurrence.countSince,
    },
  };
}
