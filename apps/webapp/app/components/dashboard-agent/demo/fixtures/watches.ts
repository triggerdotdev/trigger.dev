/**
 * Watch fixtures — specs typed against the contracts package, plus the chip
 * state the panel shows for each and the narration the agent writes when a
 * watch wakes, expires, or can't verify its condition.
 *
 * The chip is the only always-visible piece of a watch, so it carries its own
 * state (`active` / `fired` / `expired` / `cancelled`) straight from
 * `watchStatuses`, and its identity comes from `watchIdentity(spec)` — the same
 * dedupe key the host uses, so two chips can never disagree with the store
 * about whether they watch the same thing.
 */
import {
  watchIdentity,
  type WatchSpec,
  type WatchStatus,
} from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoId } from "../ids";

export type DemoWatch = {
  /** Demo-namespaced watch id. */
  id: string;
  spec: WatchSpec;
  status: WatchStatus;
  /** Dedupe identity, derived — never hand-written. */
  identity: string;
  /** Short chip label, e.g. "backlog-drain". */
  chipLabel: string;
  /** When it was created / when it will expire, for the chip tooltip. */
  createdAt: string;
  expiresAt: string;
  /** Whether the chip offers a cancel affordance. Only an active watch does. */
  cancellable: boolean;
};

const watch = (
  name: string,
  spec: WatchSpec,
  chipLabel: string,
  status: WatchStatus,
  createdAt: string,
  expiresAt: string
): DemoWatch => ({
  id: demoId(`watch-${name}`),
  spec,
  status,
  identity: watchIdentity(spec),
  chipLabel,
  createdAt,
  expiresAt,
  cancellable: status === "active",
});

/** Active: waiting for a specific run to finish. Run-state cadence — 1 minute is legal. */
export const demoRunFinishedWatch = watch(
  "run-finished",
  {
    kind: "run_finished",
    runId: DEMO_WORLD.failedRunId,
    note: "Tell me when the retry of send-order-receipt finishes.",
    maxHours: 2,
    checkEveryMinutes: 1,
  },
  DEMO_WORLD.taskId,
  "active",
  "2026-07-27T10:15:10.000Z",
  "2026-07-27T12:15:10.000Z"
);

/** Active: aggregate condition, so the cadence floor is 5 minutes. */
export const demoBacklogDrainWatch = watch(
  "backlog-drain",
  {
    kind: "backlog_drain",
    queue: DEMO_WORLD.backlogQueue,
    note: "Tell me when the backlog on demo-backlog-drain clears.",
    maxHours: 6,
    checkEveryMinutes: 5,
  },
  "backlog-drain",
  "active",
  "2026-07-27T09:02:00.000Z",
  "2026-07-27T15:02:00.000Z"
);

/** Fired: the condition happened and the user has been told. */
export const demoErrorRecurrenceWatch = watch(
  "email-sends",
  {
    kind: "error_recurrence",
    fingerprint: DEMO_WORLD.errorFingerprint,
    note: "Tell me if the rate-limit error comes back.",
    maxHours: 12,
    checkEveryMinutes: 15,
  },
  "email-sends",
  "fired",
  "2026-07-26T22:40:00.000Z",
  "2026-07-27T10:40:00.000Z"
);

/** Expired without ever being satisfied. */
export const demoHealthRecoveryWatch = watch(
  "health-recovery",
  {
    kind: "health_recovery",
    report: "health",
    fromSeverity: "crit",
    note: "Tell me when prod is healthy again.",
    maxHours: 4,
    checkEveryMinutes: 15,
  },
  "health-recovery",
  "expired",
  "2026-07-27T04:20:00.000Z",
  "2026-07-27T08:20:00.000Z"
);

/** Cancelled by the user from the chip. */
export const demoCancelledWatch = watch(
  "run-start",
  {
    kind: "run_start",
    runId: DEMO_WORLD.waitingRunId,
    note: "Tell me when this run starts.",
    maxHours: 1,
    checkEveryMinutes: 1,
  },
  "run-start",
  "cancelled",
  "2026-07-27T10:01:00.000Z",
  "2026-07-27T11:01:00.000Z"
);

/** The chip row as it looks with watches in every state at once. */
export const demoWatchRow: DemoWatch[] = [
  demoRunFinishedWatch,
  demoBacklogDrainWatch,
  demoErrorRecurrenceWatch,
  demoHealthRecoveryWatch,
  demoCancelledWatch,
];

/** Just the live ones — the normal case the header shows. */
export const demoActiveWatchRow: DemoWatch[] = [demoRunFinishedWatch, demoBacklogDrainWatch];

// ---------------------------------------------------------------------------
// Narration. A watch speaks exactly once per outcome, in the chat, unprompted —
// so the wording carries the whole burden of explaining why a message appeared.
// ---------------------------------------------------------------------------

export const demoWatchNarration = {
  /** The watch fired: say what happened, what it means, and stop watching. */
  wake: `**The retry finished.** \`${DEMO_WORLD.failedRunId}\` completed successfully 4 minutes ago, on attempt 2 — the provider accepted the request once the delay pushed it out of the rate-limit window.

I've stopped watching it. The other 40 runs from the same burst are still queued behind the concurrency limit; ask me if you want them watched too.`,

  /** Expired having verified the condition never happened. */
  expiry: `**I've stopped watching \`${DEMO_WORLD.backlogQueue}\`.** The 6-hour window is up and the backlog never fully drained — it's down from 4,812 to 610 pending, so it's clearing, just slower than the window I was given.

Ask again if you want another 6 hours.`,

  /**
   * Expired unable to verify. Different failure mode from the above and it must
   * not be dressed up as an answer: the watch could not check, so it says so.
   */
  expiryUnverified: `**I've stopped watching prod's health, but I couldn't verify the condition at expiry.** The health data was unavailable on my last few checks, so I can't tell you whether prod recovered — only that I never saw it recover.

Re-run the health report to get a current answer.`,

  /** Cancelled from the chip. Short, no narration theatre. */
  cancelled: `Stopped watching \`${DEMO_WORLD.waitingRunId}\`.`,
} as const;

export const demoWatches = {
  runFinished: demoRunFinishedWatch,
  backlogDrain: demoBacklogDrainWatch,
  errorRecurrence: demoErrorRecurrenceWatch,
  healthRecovery: demoHealthRecoveryWatch,
  cancelled: demoCancelledWatch,
  row: demoWatchRow,
  activeRow: demoActiveWatchRow,
  narration: demoWatchNarration,
} as const;
