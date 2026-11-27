import { fenceUntrusted } from "../../gate/fence.server";
import { SCHEDULE_ID } from "../schemas/schedules";
import { capText, untrusted } from "./logFields";
import { escapeText } from "./runsEditPreview";

const TEXT_CHARS = 256;
const ANCHOR = /^Next fire times after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z) /m;
const TIMEZONES = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);
const ENVIRONMENT_TYPES = new Set(["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"]);

export const FIRE_TIMES = 3;

export type FireTime = { nominalAt: Date; effectiveAt?: Date };

export type WindowFacts = {
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
  defaultWindowDurationSeconds: number | null;
  minimumWindowDurationSeconds: number | null;
};

export type EnvironmentFacts = { type: string; slug: string; branchName: string | null };

export type ScheduleFacts = WindowFacts & {
  friendlyId: string;
  taskIdentifier: string;
  cron: string;
  cronDescription: string;
  timezone: string;
  externalId: string | null;
  deduplicationKey: string | null;
  active: boolean;
};

export const scheduleId = (id: string) =>
  SCHEDULE_ID.test(id) ? id : untrusted(id, "schedule-id", 128);

const TASK_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** A task id the caller passed: plain when it looks like one, fenced otherwise. */
export const taskIdText = (id: string) =>
  TASK_ID.test(id) ? id : untrusted(id, "schedule-task-id", 128);

const timezoneText = (timezone: string) =>
  TIMEZONES.has(timezone) ? timezone : untrusted(timezone, "schedule-timezone", 64);

const fenced = (value: string, source: string) => untrusted(value, source, TEXT_CHARS);

export const anchorFrom = (now: Date) => new Date(Math.floor(now.getTime() / 60_000) * 60_000);

export function storedAnchor(preview: string | undefined): Date | undefined {
  const match = preview ? ANCHOR.exec(preview) : null;
  return match ? new Date(match[1]) : undefined;
}

function duration(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds / 60}m`;
}

export function describeWindow(facts: WindowFacts): string {
  const minimum =
    facts.minimumWindowDurationSeconds === null
      ? ""
      : ` A free-plan minimum spread of ${duration(facts.minimumWindowDurationSeconds)} also applies.`;
  if (facts.windowPercentage !== null) {
    return `Window: ${facts.windowPercentage}% — each run starts at a fixed point within ${facts.windowPercentage}% of the time until the next fire time.${minimum}`;
  }
  if (facts.windowDurationSeconds !== null) {
    const spread = duration(facts.windowDurationSeconds);
    return `Window: ${spread} — each run starts at a fixed point within ${spread} (at least a minute) after its fire time.${minimum}`;
  }
  if (facts.defaultWindowDurationSeconds !== null) {
    const spread = duration(facts.defaultWindowDurationSeconds);
    return `Window: none set, so the ${spread} default captured for this schedule applies — each run starts at a fixed point within ${spread} after its fire time.${minimum}`;
  }
  return `Window: none — each run starts within a minute after its fire time.${minimum}`;
}

export function environmentLabel(environment: EnvironmentFacts): string {
  const type = ENVIRONMENT_TYPES.has(environment.type) ? environment.type.toLowerCase() : "unknown";
  return environment.branchName
    ? `${type} branch ${escapeText(environment.branchName)}`
    : `${type} (${escapeText(environment.slug)})`;
}

export function fireTimeLines(anchor: Date, times: FireTime[], timezone: string): string[] {
  return [
    `Next fire times after ${anchor.toISOString()} (when this was previewed), from the cron in ${escapeText(timezone)}:`,
    ...times.map(({ nominalAt, effectiveAt }) =>
      effectiveAt && effectiveAt.getTime() !== nominalAt.getTime()
        ? `- ${nominalAt.toISOString()} (the run starts at ${effectiveAt.toISOString()})`
        : `- ${nominalAt.toISOString()}`
    ),
  ];
}

export function scheduleSummary(facts: ScheduleFacts, environment: EnvironmentFacts): string[] {
  return [
    `Schedule ${scheduleId(facts.friendlyId)} in the ${environmentLabel(environment)} environment triggers task ${escapeText(facts.taskIdentifier)}.`,
    `Cron: ${escapeText(facts.cron)} (${escapeText(facts.cronDescription)})`,
    `Timezone: ${escapeText(facts.timezone)}`,
    describeWindow(facts),
    `External ID: ${facts.externalId === null ? "none" : escapeText(facts.externalId)}`,
  ];
}

export const DEV_NOTE =
  "In a development environment it triggers runs only while the dev CLI is connected.";

export type ListedSchedule = {
  friendlyId: string;
  type: string;
  taskIdentifier: string;
  cron: string;
  cronDescription: string;
  timezone: string;
  window?: string;
  windowSource?: string;
  externalId: string | null;
  deduplicationKey: string | null;
  userProvidedDeduplicationKey: boolean;
  active: boolean;
  nextRun?: Date;
  nextRunEffectiveAt?: Date;
  lastRun?: Date;
  lastRunFiredAt?: Date;
  otherEnvironments: number;
};

/** A cron fire time, followed by when its run starts if the window moves it. */
const fireTimeWithStart = (firesAt: Date, startsAt: Date | undefined) =>
  `${firesAt.toISOString()}${
    startsAt && startsAt.getTime() !== firesAt.getTime()
      ? ` (starts at ${startsAt.toISOString()})`
      : ""
  }`;

export function scheduleFields(schedule: ListedSchedule): string[] {
  const window = schedule.window
    ? `${schedule.window}${schedule.windowSource === "schedule_default" ? " (default)" : ""}`
    : "none";
  return [
    `type: ${schedule.type === "DECLARATIVE" ? "declarative (defined in code, changed by deploying)" : "imperative"}`,
    `status: ${schedule.active ? "active" : "inactive"}`,
    `task: ${fenced(schedule.taskIdentifier, "schedule-task")}`,
    `cron: ${fenced(schedule.cron, "schedule-cron")} (${fenced(schedule.cronDescription, "schedule-cron-description")})`,
    `timezone: ${timezoneText(schedule.timezone)}`,
    `window: ${/^\d{1,4}[mh%]$/.test(schedule.window ?? "") || !schedule.window ? window : fenced(window, "schedule-window")}`,
    ...(schedule.nextRun
      ? [`next run: ${fireTimeWithStart(schedule.nextRun, schedule.nextRunEffectiveAt)}`]
      : []),
    ...(schedule.lastRunFiredAt
      ? [
          `previous fire time (from the cron; not a check that a run happened): ${fireTimeWithStart(schedule.lastRunFiredAt, schedule.lastRun)}`,
        ]
      : []),
    `external ID: ${schedule.externalId ? fenced(schedule.externalId, "schedule-external-id") : "none"}`,
    `deduplication key: ${
      schedule.userProvidedDeduplicationKey && schedule.deduplicationKey
        ? fenced(schedule.deduplicationKey, "schedule-deduplication-key")
        : "generated"
    }`,
    `environments: this one${
      schedule.otherEnvironments > 0
        ? ` and ${schedule.otherEnvironments} other${schedule.otherEnvironments === 1 ? "" : "s"}`
        : ""
    }`,
  ];
}

/** Names the schedule asked for and where to find the right id, only in this environment. */
export const scheduleNotFound = (id: string) =>
  `Schedule ${scheduleId(id)} was not found in this environment. Use list_schedules to see the schedules in this environment.`;

export const refusalText = (prefix: string, message: string) =>
  `${prefix}: ${fenceUntrusted(capText(message, TEXT_CHARS), "schedule-error")}; nothing changed.`;
