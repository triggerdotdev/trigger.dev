import {
  watchIdentity,
  type WatchSpec,
  type WatchStatus,
} from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoId } from "../ids";

export type DemoWatch = {
  id: string;
  spec: WatchSpec;
  status: WatchStatus;
  identity: string;
  chipLabel: string;
  createdAt: string;
  expiresAt: string;
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

const demoRunFinishedWatch = watch(
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

const demoErrorRecurrenceWatch = watch(
  "email-sends",
  {
    kind: "error_recurrence",
    // The page cites `error_<fingerprint>`, the spec keeps the bare form.
    fingerprint: DEMO_WORLD.errorFingerprint.replace(/^error_/, ""),
    note: "Tell me if the rate-limit error comes back.",
    maxHours: 12,
    checkEveryMinutes: 15,
  },
  "email-sends",
  "fired",
  "2026-07-26T22:40:00.000Z",
  "2026-07-27T10:40:00.000Z"
);

const demoHealthRecoveryWatch = watch(
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

const demoCancelledWatch = watch(
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

const demoWatchRow: DemoWatch[] = [
  demoRunFinishedWatch,
  demoBacklogDrainWatch,
  demoErrorRecurrenceWatch,
  demoHealthRecoveryWatch,
  demoCancelledWatch,
];

const demoActiveWatchRow: DemoWatch[] = [demoRunFinishedWatch, demoBacklogDrainWatch];

export const demoWatchNarration = {
  wake: `**The retry finished.** \`${DEMO_WORLD.failedRunId}\` completed successfully 4 minutes ago, on attempt 2 — the provider accepted the request once the delay pushed it out of the rate-limit window.

I've stopped watching it. The other 40 runs from the same burst are still queued behind the concurrency limit; ask me if you want them watched too.`,

  expiry: `**I've stopped watching \`${DEMO_WORLD.backlogQueue}\`.** The 6-hour window is up and the backlog never fully drained — it's down from 4,812 to 610 pending, so it's clearing, just slower than the window I was given.

Ask again if you want another 6 hours.`,

  expiryUnverified: `**I've stopped watching prod's health, but I couldn't verify the condition at expiry.** The health data was unavailable on my last few checks, so I can't tell you whether prod recovered — only that I never saw it recover.

Re-run the health report to get a current answer.`,

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
