import { normalizeSearchText } from "@trigger.dev/core/utils";
import { z } from "zod";
import type { ClickhouseInsertFunction, ClickhouseWriter } from "./client/types.js";
import { serializeTaskEventAttributes, type TaskEventV2Input } from "./taskEvents.js";

export const TaskEventSearchV2Input = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  triggered_timestamp: z.string(),
  trace_id: z.string(),
  span_id: z.string(),
  run_id: z.string(),
  task_identifier: z.string(),
  start_time: z.string(),
  inserted_at: z.string(),
  message: z.string(),
  error_message: z.string(),
  search_text: z.string(),
  kind: z.string(),
  status: z.string(),
  duration: z.string(),
  parent_span_id: z.string(),
});

export type TaskEventSearchV2Input = z.input<typeof TaskEventSearchV2Input>;

export const TASK_EVENT_SEARCH_V2_INSERT_COLUMNS = [
  "environment_id",
  "organization_id",
  "project_id",
  "triggered_timestamp",
  "trace_id",
  "span_id",
  "run_id",
  "task_identifier",
  "start_time",
  "inserted_at",
  "message",
  "error_message",
  "search_text",
  "kind",
  "status",
  "duration",
  "parent_span_id",
] satisfies [string, ...string[]];

export function boundedUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.length <= maxBytes ? value : buffer.subarray(0, maxBytes).toString("utf8");
}

export function buildSearchText(message: string, attributesText: string): string {
  const joined =
    boundedUtf8(message, 2045) + " " + boundedUtf8(attributesText, 6140).split("\\/").join("/");

  return boundedUtf8(normalizeSearchText(joined), 8189);
}

function passesCheapEligibilityChecks(event: TaskEventV2Input): boolean {
  if (event.trace_id === "") return false;
  if (event.kind === "DEBUG_EVENT") return false;
  if (event.status === "PARTIAL") return false;
  if (event.kind === "ANCESTOR_OVERRIDE") return false;
  if (event.message === "trigger.dev/start") return false;
  return true;
}

export function isTaskEventSearchEligible(event: TaskEventV2Input): boolean {
  if (!passesCheapEligibilityChecks(event)) return false;
  if (event.kind === "SPAN_EVENT" && serializeTaskEventAttributes(event.attributes) === "{}") {
    return false;
  }
  return true;
}

/** Returns undefined when the event is not search-eligible. Serializes attributes at most once. */
export function toTaskEventSearchV2RowIfEligible(
  event: TaskEventV2Input,
  now: Date
): TaskEventSearchV2Input | undefined {
  if (!passesCheapEligibilityChecks(event)) return undefined;
  const attributesText = serializeTaskEventAttributes(event.attributes);
  if (event.kind === "SPAN_EVENT" && attributesText === "{}") return undefined;
  return toTaskEventSearchV2Row(event, now, attributesText);
}

export function toTaskEventSearchV2Row(
  event: TaskEventV2Input,
  now: Date,
  attributesText = serializeTaskEventAttributes(event.attributes)
): TaskEventSearchV2Input {
  const insertedAt = event.inserted_at ?? formatMilliseconds(now);

  return {
    environment_id: event.environment_id,
    organization_id: event.organization_id,
    project_id: event.project_id,
    triggered_timestamp: triggeredTimestamp(event.start_time, event.duration, insertedAt),
    trace_id: event.trace_id,
    span_id: event.span_id,
    run_id: event.run_id,
    task_identifier: event.task_identifier,
    start_time: event.start_time,
    inserted_at: insertedAt,
    message: event.message,
    error_message: boundedUtf8(errorMessage(event.attributes), 2045),
    search_text: buildSearchText(event.message, attributesText),
    kind: event.kind,
    status: event.status,
    duration: event.duration,
    parent_span_id: event.parent_span_id,
  };
}

export function insertTaskEventsSearchV2(
  ch: ClickhouseWriter
): ClickhouseInsertFunction<TaskEventSearchV2Input> {
  return ch.insertUnsafe<TaskEventSearchV2Input>({
    name: "insertTaskEventsSearchV2",
    table: "trigger_dev.task_events_search_v2",
    columns: TASK_EVENT_SEARCH_V2_INSERT_COLUMNS,
  });
}

function errorMessage(attributes: unknown): string {
  if (attributes == null || typeof attributes !== "object") return "";

  const error = (attributes as Record<string, unknown>).error;
  if (error == null || typeof error !== "object") return "";

  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

function triggeredTimestamp(startTime: string, duration: string, insertedAt: string): string {
  const completedAt = parseNanoseconds(startTime) + BigInt(duration);
  const latestAllowed = parseMilliseconds(insertedAt) + BigInt(5 * 60_000) * BigInt(1_000_000);
  return formatNanoseconds(completedAt < latestAllowed ? completedAt : latestAllowed);
}

function parseNanoseconds(value: string): bigint {
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }

  const epoch = /^(\d+)\.(\d{1,9})$/.exec(value);
  if (!epoch) {
    throw new Error(`Invalid DateTime64(9) value: ${value}`);
  }

  return BigInt(epoch[1]) * BigInt(1_000_000_000) + BigInt(epoch[2].padEnd(9, "0"));
}

function parseMilliseconds(value: string): bigint {
  const numeric = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value);
  if (numeric) {
    return (
      BigInt(numeric[1]) * BigInt(1_000_000_000) +
      BigInt((numeric[2] ?? "").padEnd(3, "0")) * BigInt(1_000_000)
    );
  }

  const iso = value.replace(" ", "T");
  const milliseconds = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid DateTime64(3) value: ${value}`);
  }

  return BigInt(milliseconds) * BigInt(1_000_000);
}

function formatNanoseconds(value: bigint): string {
  const seconds = value / BigInt(1_000_000_000);
  const nanoseconds = value % BigInt(1_000_000_000);
  return `${seconds}.${nanoseconds.toString().padStart(9, "0")}`;
}

function formatMilliseconds(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}
