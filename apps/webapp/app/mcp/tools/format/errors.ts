import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import parseDuration from "parse-duration";
import type { ErrorGroupDetail, ErrorGroupListItem } from "@trigger.dev/core/v3";
import type { ErrorGroupSummary } from "~/presenters/v3/ErrorGroupPresenter.server";
import type { NextRunList } from "~/presenters/v3/NextRunListPresenter.server";
import type { ErrorListWindow } from "~/presenters/v3/ApiErrorListPresenter.server";
import { plural } from "./insights";
import { quoteForPreview } from "./webhooks";
import { capText, renderCursor, untrusted } from "./logFields";

const LIST_MESSAGE_CHARS = 300;
const DETAIL_MESSAGE_CHARS = 4_000;
const PREVIEW_MESSAGE_CHARS = 1_000;
const NAME_CHARS = 200;

const FINGERPRINT = /^[A-Za-z0-9]{1,64}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
const RUN_ID = /^run_[A-Za-z0-9]{1,64}$/;
const RUN_STATUS = /^[A-Z_]{1,40}$/;

const ERROR_ID = /^error_[A-Za-z0-9]{1,64}$/;

/** A write's answer, naming the task whose group changed since an id can occur in several. */
export const writtenAnswer = (done: string, errorId: string, task: string) =>
  `${done} error group ${plain(errorId, ERROR_ID, "error-id")} of task ${untrusted(task, "error-task", NAME_CHARS)}.`;

/** Names the error asked for and where to find the right id, only in this environment. */
export const errorNotFound = (errorId: string) =>
  `Error ${plain(errorId, ERROR_ID, "error-id")} was not found in this environment. Use list_errors to see the errors in this environment.`;

const errorIdOf = (fingerprint: string) =>
  FINGERPRINT.test(fingerprint)
    ? `error_${fingerprint}`
    : `${untrusted(fingerprint, "error-fingerprint", 128)} (not a usable error id)`;

const plain = (value: string, pattern: RegExp, source: string) =>
  pattern.test(value) ? value : untrusted(value, source, 128);

const time = (date: Date | null | undefined) =>
  date && !Number.isNaN(date.getTime()) ? date.toISOString() : "unknown";

const errorText = (type: string, message: string, chars: number) =>
  `${untrusted(type, "error-type", NAME_CHARS)} ${untrusted(message, "error-message", chars)}`;

/**
 * The period that set the window, as the list presenter applies it: a period it cannot parse
 * falls back to the default 1d even with from/to; from/to alone need no label.
 */
const PERIOD = /^\d{1,6}[smhdw]$/;

export const appliedPeriod = (input: { period?: string; from?: string; to?: string }) =>
  input.period
    ? parseDuration(input.period)
      ? `period ${plain(input.period, PERIOD, "error-period")}`
      : "the default period 1d"
    : input.from || input.to
      ? undefined
      : "the default period 1d";

export function formatErrorList(
  page: {
    data: ErrorGroupListItem[];
    pagination: { next?: string; previous?: string };
    window: ErrorListWindow;
  },
  period: string | undefined
): string {
  const { from, to, retentionDays, clampedByRetention } = page.window;
  const range = `from ${time(from)} to ${time(to)}${period ? ` (${period})` : ""}`;
  const clamp = clampedByRetention
    ? [
        `Errors are kept for ${retentionDays} days, so the window was cut to start at ${time(from)}; older errors cannot be listed.`,
      ]
    : [];
  const tasksPerId = page.data.reduce(
    (counts, group) => counts.set(group.fingerprint, (counts.get(group.fingerprint) ?? 0) + 1),
    new Map<string, number>()
  );
  const idCount = tasksPerId.size;
  const lines: string[] = [];
  if (page.data.length === 0) {
    lines.push(`No error groups found ${range}.`, ...clamp);
    if (!clampedByRetention) {
      lines.push("To look further back, pass a longer period such as 7d or 30d, or from and to.");
    }
  } else {
    lines.push(
      `Showing ${page.data.length} error group${page.data.length === 1 ? "" : "s"} ${range}, most occurrences first. A group is one error id in one task, so ${idCount === 1 ? "this is" : "these are"} ${plural(idCount, "error id")}:`,
      ...clamp
    );
    page.data.forEach((group, i) => {
      const shared =
        (tasksPerId.get(group.fingerprint) ?? 0) > 1 ? " | also listed for another task" : "";
      const status =
        group.status === "resolved"
          ? `resolved at ${time(group.resolvedAt)}`
          : group.status === "ignored" && group.ignoredUntil
            ? `ignored until ${time(group.ignoredUntil)}`
            : group.status;
      lines.push(
        `${i + 1}. ${errorIdOf(group.fingerprint)} | ${status} | ${plural(group.count, "occurrence")} | task ${untrusted(group.taskIdentifier, "error-task", NAME_CHARS)} | first seen ${time(group.firstSeen)} | last seen ${time(group.lastSeen)}${shared}`
      );
      lines.push(`   ${errorText(group.errorType, group.errorMessage, LIST_MESSAGE_CHARS)}`);
    });
    lines.push(
      page.pagination.next
        ? `More error groups match. To continue, call again with after set to the next cursor, from "${time(from)}" and to "${time(to)}" instead of period, and the same other filters, so every page counts this same window. Counts can still change while paging (new occurrences, or the retention cut moving), so a group can repeat or be missed; listing again gives a fresh order.`
        : page.pagination.previous
          ? "This is the last page for this window and these filters."
          : "This is every error group for this window and these filters.",
      "Occurrence counts are for this window; first and last seen are over all time. Use get_error_details for one group in full."
    );
  }

  for (const [key, label, arg] of [
    ["next", "Next cursor", "after"],
    ["previous", "Previous cursor", "before"],
  ] as const) {
    const cursor = page.pagination[key];
    if (!cursor) continue;
    const rendered = renderCursor(cursor);
    lines.push(
      rendered
        ? `${label}: ${rendered} (pass it as ${arg} with the same filters)`
        : `${label}: too large to return. Narrow the filters to continue.`
    );
  }
  return lines.join("\n");
}

function ignoreConditions(state: {
  ignoredUntil: Date | null;
  ignoredUntilOccurrenceRate: number | null;
  ignoredUntilTotalOccurrences: number | null;
}): string[] {
  const conditions: string[] = [];
  if (state.ignoredUntil) conditions.push(`until ${time(state.ignoredUntil)}`);
  if (state.ignoredUntilOccurrenceRate !== null) {
    conditions.push(`until it occurs more than ${state.ignoredUntilOccurrenceRate} times a minute`);
  }
  if (state.ignoredUntilTotalOccurrences !== null) {
    conditions.push(`until it occurs ${state.ignoredUntilTotalOccurrences} more times`);
  }
  return conditions;
}

export function formatErrorDetail(
  group: ErrorGroupSummary,
  runList: NextRunList | undefined,
  range: { from: Date; to: Date },
  url: string | undefined
): string {
  const { state } = group;
  const lines = [
    `Error ${errorIdOf(group.fingerprint)}`,
    `Status: ${state.status.toLowerCase()}`,
    `Task: ${untrusted(group.taskIdentifier, "error-task", NAME_CHARS)}`,
    `Type: ${untrusted(group.errorType, "error-type", NAME_CHARS)}`,
    `Message: ${untrusted(group.errorMessage, "error-message", DETAIL_MESSAGE_CHARS)}`,
    `Occurrences: ${group.count} in total, first seen ${time(group.firstSeen)}, last seen ${time(group.lastSeen)}`,
    `Affected versions (newest first, up to 5): ${
      group.affectedVersions.length
        ? group.affectedVersions.map((v) => plain(v, VERSION, "error-version")).join(", ")
        : "none recorded"
    }`,
  ];

  if (state.status === "RESOLVED") {
    const version = state.resolvedInVersion
      ? ` in version ${plain(state.resolvedInVersion, VERSION, "error-version")}`
      : "";
    lines.push(`Resolved at ${time(state.resolvedAt)}${version}`);
  }
  if (state.status === "IGNORED") {
    const conditions = ignoreConditions(state);
    lines.push(
      `Ignored at ${time(state.ignoredAt)}, ${conditions.length ? conditions.join(" or ") : "indefinitely"}`
    );
    if (state.ignoredReason) {
      lines.push(`Ignore reason: ${untrusted(state.ignoredReason, "error-ignore-reason", 1_000)}`);
    }
  }
  if (url) lines.push(`Dashboard: ${url}`);

  lines.push(`Recent runs with this error, ${time(range.from)} to ${time(range.to)}:`);
  if (!runList || runList.runs.length === 0) {
    lines.push("No runs found in this time range.");
    return lines.join("\n");
  }
  for (const run of runList.runs) {
    const version = run.version ? plain(run.version, VERSION, "error-version") : "no version";
    lines.push(
      `- ${plain(run.friendlyId, RUN_ID, "error-run-id")} | ${plain(run.status, RUN_STATUS, "error-run-status")} | ${version} | created ${run.createdAt}${run.finishedAt ? ` | finished ${run.finishedAt}` : ""}`
    );
  }
  const next = runList.pagination.next && renderCursor(runList.pagination.next);
  if (next) lines.push(`More runs: pass runsCursor ${next} with the same arguments.`);
  return lines.join("\n");
}

type PreviewArgs = { errorId: string; environment: string; branch?: string };

export type ErrorPreview = string | { refuse: string };

export type StoredGroup = { group: ErrorGroupDetail; hasState: boolean; revision: string };

const revisionLine = (revision: string) =>
  `Error group revision ${revision}: if the group changes before this runs, it is refused.`;

const quoted = (value: string, chars = NAME_CHARS) => quoteForPreview(capText(value, chars));

const reasonOf = (reason: string | undefined) => reason || undefined;

function header(tool: string, args: PreviewArgs, group: ErrorGroupDetail): string[] {
  const where = args.branch
    ? `${args.environment} branch ${quoteForPreview(args.branch)}`
    : args.environment;
  return [
    `${tool} in ${where}: error group ${args.errorId} of task ${quoted(group.taskIdentifier)}, currently ${group.status}.`,
    `Error: ${quoted(group.errorType)} ${quoted(group.errorMessage, PREVIEW_MESSAGE_CHARS)}`,
  ];
}

/**
 * A preview without its error type and message line. ClickHouse can return a different sample
 * message for the same group on each read, so approvals are compared without it; everything
 * else, including the stored state and the revision, still has to match.
 */
export const comparablePreview = (preview: string) =>
  preview
    .split("\n")
    .filter((line, i) => !(i === 1 && line.startsWith("Error: ")))
    .join("\n");

function storedIgnore(group: ErrorGroupDetail): string {
  const conditions = ignoreConditions(group);
  const reason = group.ignoredReason ? `, reason ${quoted(group.ignoredReason, 1_000)}` : "";
  return `${conditions.length ? conditions.join(" or ") : "indefinitely"}${reason}`;
}

const NO_CHANNEL =
  "These checks run only while the project has an enabled error alert channel; without one";

const versionText = (version: string | null | undefined) => (version ? quoted(version) : "none");

export function resolvePreview(
  args: PreviewArgs & { resolvedInVersion?: string },
  { group, revision }: StoredGroup
): ErrorPreview {
  const version = args.resolvedInVersion
    ? ` in version ${quoteForPreview(args.resolvedInVersion)} (recorded only; it does not change when the error counts as back)`
    : "";
  const previous =
    group.status === "ignored"
      ? [`Its ignore setting (ignored ${storedIgnore(group)}) is removed.`]
      : group.status === "resolved"
        ? [
            `It is already resolved since ${time(group.resolvedAt)}; resolving again restarts regression detection from now, so occurrences since then no longer count as a regression.`,
            ...((args.resolvedInVersion ?? null) !== group.resolvedInVersion
              ? [
                  `Resolved-in version: ${versionText(group.resolvedInVersion)} → ${versionText(args.resolvedInVersion)}.`,
                ]
              : []),
          ]
        : [];
  return [
    ...header("resolve_error", args, group),
    ...previous,
    `It becomes resolved now, recorded as resolved by you${version}.`,
    `If it occurs again, an error alert is sent as a regression and it becomes unresolved. ${NO_CHANNEL} it stays resolved.`,
    revisionLine(revision),
  ].join("\n");
}

export function ignorePreview(
  args: PreviewArgs & {
    duration?: number;
    occurrenceRate?: number;
    totalOccurrences?: number;
    reason?: string;
  },
  { group, revision }: StoredGroup
): ErrorPreview {
  const reason = reasonOf(args.reason);
  if (
    group.status === "ignored" &&
    args.duration === undefined &&
    args.totalOccurrences === undefined &&
    group.ignoredUntil === null &&
    group.ignoredUntilTotalOccurrences === null &&
    (args.occurrenceRate ?? null) === group.ignoredUntilOccurrenceRate &&
    (reason ?? null) === group.ignoredReason
  ) {
    return {
      refuse: `Error ${args.errorId} is already ignored with the same condition; nothing changed.`,
    };
  }

  const conditions: string[] = [];
  if (args.duration !== undefined) {
    conditions.push(
      `for ${args.duration} ms (${formatDurationMilliseconds(args.duration)}) from when it is applied`
    );
  }
  if (args.occurrenceRate !== undefined) {
    conditions.push(
      `until it occurs more than ${args.occurrenceRate} times a minute, averaged between alert checks`
    );
  }
  if (args.totalOccurrences !== undefined) {
    conditions.push(
      `until it occurs ${args.totalOccurrences} more times, counted from its total when it is applied`
    );
  }

  const previous =
    group.status === "ignored"
      ? [`Its current ignore setting (ignored ${storedIgnore(group)}) is replaced.`]
      : group.status === "resolved"
        ? ["Its resolution is removed."]
        : [];
  const outcome = conditions.length
    ? `When the first condition is met, an error alert is sent and it becomes unresolved. ${NO_CHANNEL} it stays ignored.`
    : "It stays ignored until it is resolved or unresolved.";

  return [
    ...header("ignore_error", args, group),
    ...previous,
    `It becomes ignored now, recorded as ignored by you, ${conditions.length ? conditions.join(" or ") : "indefinitely"}.`,
    reason ? `Reason: ${quoteForPreview(reason)}` : "No reason.",
    "No error alerts are sent for it while it is ignored.",
    outcome,
    revisionLine(revision),
  ].join("\n");
}

export function unresolvePreview(
  args: PreviewArgs,
  { group, hasState, revision }: StoredGroup
): ErrorPreview {
  if (group.status === "unresolved" && hasState) {
    return { refuse: `Error ${args.errorId} is already unresolved; nothing changed.` };
  }
  const cleared =
    group.status === "ignored"
      ? `Its ignore setting (ignored ${storedIgnore(group)}) is removed.`
      : group.status === "resolved"
        ? `Its resolution is removed${group.resolvedInVersion ? `, including version ${quoted(group.resolvedInVersion)}` : ""}.`
        : "It has no stored status yet. Unresolving stores one; its only effect is that the next error alert check will not send a new-error alert for it, which it would if the error first appeared after the previous check.";
  return [
    ...header("unresolve_error", args, group),
    cleared,
    "It becomes unresolved. While unresolved, no error alerts are sent when it occurs again.",
    revisionLine(revision),
  ].join("\n");
}
