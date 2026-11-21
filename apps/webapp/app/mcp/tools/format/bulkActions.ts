import parseDuration from "parse-duration";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { PREVIEW_LIMIT } from "../../confirm/confirmation.server";
import type { BulkActionFilter } from "../schemas/bulkActions";
import { untrusted } from "./logFields";
import { escapeText, PREVIEW_TOO_LARGE } from "./runsEditPreview";

const NAME_CHARS = 256;
const FILTER_CHARS = 4_096;
const LISTED_RUN_IDS = 20;
const BULK_ID = /^bulk_[a-z0-9]{1,64}$/i;
const RUN_ID = /^run_[a-z0-9]{1,64}$/i;
const TYPES = new Set(["CANCEL", "REPLAY"]);
const STATUSES = new Set(["PENDING", "COMPLETED", "ABORTED"]);

export const DEFAULT_RUN_PERIOD = timeFilters({}).period!;

type TimeKey = "from" | "to" | "period";

const FILTER_LABELS: Record<Exclude<keyof BulkActionFilter, TimeKey>, string> = {
  status: "status",
  taskIdentifier: "task",
  version: "version",
  tag: "tag",
  queue: "queue",
  machine: "machine",
  region: "region",
  batch: "batch",
  schedule: "schedule",
  bulkAction: "bulk action",
  error: "error",
  rootOnly: "root runs only",
};

export type TimeWindow = { from?: number; to: number } & (
  | { period: string; isDefault: boolean }
  | { period?: undefined; endsAtStart: boolean }
);

export function timeWindowOf(filter: BulkActionFilter, now: number): TimeWindow {
  const from = filter.from === undefined ? undefined : Date.parse(filter.from);
  const to = filter.to === undefined ? undefined : Date.parse(filter.to);
  const { period } = timeFilters({ period: filter.period, from, to });
  if (period) {
    return {
      period,
      isDefault: filter.period === undefined,
      from: now - parseDuration(period)!,
      to: now,
    };
  }
  return { from, to: to ?? now, endsAtStart: to === undefined };
}

function describeWindow(window: TimeWindow): string[] {
  if (window.period !== undefined) {
    return [
      `- created in the last: ${escapeText(window.period)}${window.isDefault ? " (default)" : ""}, counted back from when the action starts`,
    ];
  }
  return [
    ...(window.from === undefined
      ? []
      : [`- created at or after: ${new Date(window.from).toISOString()}`]),
    `- created at or before: ${window.endsAtStart ? "when the action starts" : new Date(window.to).toISOString()}`,
  ];
}

function describeFilter(filter: BulkActionFilter): string[] {
  return (Object.keys(FILTER_LABELS) as Array<keyof typeof FILTER_LABELS>).flatMap((key) => {
    const value = filter[key];
    if (value === undefined) return [];
    const shown = Array.isArray(value)
      ? `any of ${value.map(escapeText).join(", ")}`
      : typeof value === "string"
        ? escapeText(value)
        : String(value);
    return [`- ${FILTER_LABELS[key]}: ${shown}`];
  });
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export type CreatePreviewInput = {
  action: "cancel" | "replay";
  environment: string;
  branch?: string;
  filter?: BulkActionFilter;
  window?: TimeWindow;
  runIds?: string[];
  count: number;
  name?: string;
  region?: string;
  emailNotification: boolean;
};

export function createBulkActionPreview(input: CreatePreviewInput): string | { refuse: string } {
  const where = input.branch
    ? `${input.environment} branch ${escapeText(input.branch)}`
    : input.environment;
  const verb = input.action === "cancel" ? "CANCEL" : "REPLAY";

  const selection = input.runIds
    ? [
        `Selection: the ${plural(input.runIds.length, "distinct run ID")} given. Every one of them that is in ${where} is targeted; the others are skipped.`,
        ...[...input.runIds].sort().map((id) => `- ${id}`),
        `Runs affected: ${input.count} found now. Runs not indexed yet may be included when the action starts.`,
      ]
    : [
        "Selection: every run in this environment that matches all of:",
        ...describeFilter(input.filter ?? {}),
        ...(input.window ? describeWindow(input.window) : []),
        `Runs affected: runs in this window that match the filter when their batch is processed; ${input.count} match now, and the number may differ by the time it starts.`,
      ];

  const effect =
    input.action === "cancel"
      ? [
          "Each run that has not finished is cancelled. Runs that already finished are left as they are.",
        ]
      : [
          "Each run is replayed: a new run of the same task with the same payload is created for every run, and the new runs consume compute.",
          input.region
            ? `The new runs run in region ${escapeText(input.region)}.`
            : "The new runs run in each original run's region.",
        ];

  const preview = [
    `create_bulk_action in ${where}: ${verb} runs.`,
    ...selection,
    ...effect,
    `Name: ${input.name === undefined ? "none" : escapeText(input.name)}`,
    `Email when finished: ${input.emailNotification ? "yes" : "no"}`,
  ].join("\n");
  return preview.length > PREVIEW_LIMIT ? { refuse: PREVIEW_TOO_LARGE } : preview;
}

export type BulkActionSummary = {
  friendlyId: string;
  type: string;
  status: string;
  totalCount: number;
  successCount: number;
  failureCount: number;
};

export function abortBulkActionPreview(
  bulkActionId: string,
  environment: string,
  found: BulkActionSummary | null
): string | { refuse: string } {
  const id = escapeText(bulkActionId);
  if (!found) {
    return { refuse: `Bulk action ${id} was not found in ${environment}; nothing changed.` };
  }
  if (found.status !== "PENDING") {
    return {
      refuse: `Bulk action ${id} is ${found.status.toLowerCase()}, so it cannot be aborted; nothing changed.`,
    };
  }
  const processed = found.successCount + found.failureCount;
  const done =
    found.type === "REPLAY"
      ? "New runs it already created are not cancelled and keep running."
      : "Runs it already cancelled stay cancelled.";
  return [
    `abort_bulk_action in ${environment}: stop ${found.type.toLowerCase()} bulk action ${id} (${processed} of ${found.totalCount} runs processed as of now).`,
    "No new batch of runs starts after this. A batch already being processed may still finish.",
    `${done} Abort does not undo anything.`,
  ].join("\n");
}

const plainOr = (value: string, valid: (v: string) => boolean, source: string) =>
  valid(value) ? value : untrusted(value, source, NAME_CHARS);

export const renderBulkActionId = (id: string) =>
  plainOr(id, (v) => BULK_ID.test(v), "bulk-action-id");

const renderName = (name: string | null | undefined) =>
  name ? untrusted(name, "bulk-action-name", NAME_CHARS) : "none";

type ListedBulkAction = {
  id: string;
  name?: string;
  type: string;
  status: string;
  counts: { total: number; success: number; failure: number };
  createdAt: Date;
  completedAt?: Date;
};

export function renderBulkActionRow(row: ListedBulkAction, index: number): string {
  return [
    `${index}. ${renderBulkActionId(row.id)}`,
    `type ${plainOr(row.type, (v) => TYPES.has(v), "bulk-action-type")}`,
    `status ${plainOr(row.status, (v) => STATUSES.has(v), "bulk-action-status")}`,
    `${row.counts.total} runs, ${row.counts.success} succeeded, ${row.counts.failure} failed`,
    `created ${row.createdAt.toISOString()}`,
    row.completedAt ? `completed ${row.completedAt.toISOString()}` : undefined,
    `name ${renderName(row.name)}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

type BulkActionDetail = BulkActionSummary & {
  name: string | null;
  createdAt: Date;
  completedAt: Date | null;
  mode: string;
  filters: Record<string, unknown>;
};

function renderSelection(detail: BulkActionDetail): string[] {
  const { runId, from, to, ...rest } = detail.filters as {
    runId?: string[];
    from?: number;
    to?: number;
  } & Record<string, unknown>;
  if (detail.mode === "selected" && runId) {
    const shown = runId
      .slice(0, LISTED_RUN_IDS)
      .map((id) => plainOr(id, (v) => RUN_ID.test(v), "bulk-action-run-id"));
    return [
      `Selection: ${plural(runId.length, "run ID")}`,
      ...shown.map((id) => `- ${id}`),
      ...(runId.length > LISTED_RUN_IDS
        ? [`… and ${runId.length - LISTED_RUN_IDS} more (showing the first ${LISTED_RUN_IDS})`]
        : []),
    ];
  }
  const filter = Object.fromEntries(
    Object.entries({
      ...rest,
      from: typeof from === "number" ? new Date(from).toISOString() : undefined,
      to: typeof to === "number" ? new Date(to).toISOString() : undefined,
    }).filter(([, value]) => value !== undefined)
  );
  return [
    `Selection: filter ${untrusted(JSON.stringify(filter), "bulk-action-filter", FILTER_CHARS)}`,
  ];
}

export function renderBulkActionDetail(detail: BulkActionDetail): string {
  return [
    `## Bulk action ${renderBulkActionId(detail.friendlyId)}`,
    `Type: ${plainOr(detail.type, (v) => TYPES.has(v), "bulk-action-type")}`,
    `Status: ${plainOr(detail.status, (v) => STATUSES.has(v), "bulk-action-status")}`,
    `Name: ${renderName(detail.name)}`,
    `Runs: ${detail.totalCount} selected when created, ${detail.successCount} succeeded, ${detail.failureCount} failed`,
    `Created: ${detail.createdAt.toISOString()}`,
    `Completed: ${detail.completedAt ? detail.completedAt.toISOString() : "not yet"}`,
    ...renderSelection(detail),
  ].join("\n");
}
