import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { SessionRunHandover } from "@trigger.dev/core/v3/schemas";

/** A run of a session, as a handover names it. */
export type HandoverRun = { friendlyId: string; version: string | null };

/**
 * A reply that moved to another run partway through: recorded on the SessionRun row of the run
 * that continued it. `reason` is that row's reason (`skew-threshold`, or `upgrade` for
 * `chat.requestUpgrade()`).
 */
export type SessionHandover = {
  afterSteps: number;
  messageId?: string;
  thresholdVersion?: string;
  reason: string;
  at: string;
  from: HandoverRun | null;
  to: HandoverRun;
};

/** A SessionRun row's `handover` column, or undefined when the row isn't a mid-turn move. */
export function parseSessionRunHandover(value: unknown): SessionRunHandover | undefined {
  const parsed = SessionRunHandover.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A session's run as a handover names it; the run row when it was read. */
export function handoverRun(
  runId: string,
  run: { friendlyId: string; taskVersion: string | null } | undefined
): HandoverRun {
  return {
    friendlyId: run?.friendlyId ?? RunId.toFriendlyId(runId),
    version: run?.taskVersion ?? null,
  };
}

/** The handover recorded on the SessionRun row of the run that continued the reply. */
export function sessionHandover(
  handover: SessionRunHandover,
  row: { reason: string; triggeredAt: Date },
  from: HandoverRun | null,
  to: HandoverRun
): SessionHandover {
  return { ...handover, reason: row.reason, at: row.triggeredAt.toISOString(), from, to };
}

export function handoverWhy(handover: Pick<SessionHandover, "reason" | "thresholdVersion">) {
  if (handover.reason === "upgrade") return "chat.requestUpgrade()";
  return handover.thresholdVersion
    ? `skew protection threshold ${handover.thresholdVersion}`
    : "skew protection threshold";
}
