import { isRunFriendlyId } from "~/components/dashboard-agent/run-id";
import { WAITPOINT_ID, WAITPOINT_LIST_CURSOR } from "../schemas/waitpoints";
import { untrusted } from "./logFields";

const ID_CHARS = 128;
const KEY_CHARS = 512;
const TAGS_CHARS = 2_048;
const OUTPUT_CHARS = 8_000;

const STATUSES = new Set(["WAITING", "COMPLETED", "TIMED_OUT"]);
const TYPES = new Set(["RUN", "DATETIME", "MANUAL", "BATCH"]);
const RUN_STATUS = /^[A-Z_]{1,32}$/;

const waitpointId = (id: string) =>
  WAITPOINT_ID.test(id) ? id : untrusted(id, "waitpoint-id", ID_CHARS);

export const waitpointMissing = (id: string) =>
  `Waitpoint ${waitpointId(id)} was not found in this environment`;

/** Names the waitpoint asked for and where to find the right id, only in this environment. */
export const waitpointNotFound = (id: string) =>
  `${waitpointMissing(id)}. Use list_waitpoint_tokens to see the waitpoint tokens in this environment.`;
const status = (value: string) =>
  STATUSES.has(value) ? value : untrusted(value, "waitpoint-status", ID_CHARS);
const iso = (date: Date) => date.toISOString();

export const renderWaitpointCursor = (cursor: string | undefined) =>
  cursor && WAITPOINT_LIST_CURSOR.test(cursor) ? cursor : undefined;

const tagList = (tags: string[]) => untrusted(tags.join(", "), "waitpoint-tags", TAGS_CHARS);

type TokenRow = {
  id: string;
  status: string;
  createdAt: Date;
  completedAt?: Date;
  timeoutAt?: Date;
  idempotencyKey?: string;
  tags: string[];
};

export function renderTokenRow(token: TokenRow): string {
  return [
    `- ${waitpointId(token.id)}`,
    `status ${status(token.status)}`,
    `created ${iso(token.createdAt)}`,
    ...(token.timeoutAt ? [`timeout ${iso(token.timeoutAt)}`] : []),
    ...(token.completedAt ? [`completed ${iso(token.completedAt)}`] : []),
    ...(token.idempotencyKey
      ? [
          `idempotency key ${untrusted(token.idempotencyKey, "waitpoint-idempotency-key", KEY_CHARS)}`,
        ]
      : []),
    ...(token.tags.length > 0 ? [`tags ${tagList(token.tags)}`] : []),
  ].join(" | ");
}

/** Status and task are only there when the caller may read runs. */
export type ConnectedRun = { friendlyId: string; taskIdentifier?: string; status?: string };

const runId = (id: string) =>
  id.length <= ID_CHARS && isRunFriendlyId(id) ? id : untrusted(id, "waitpoint-run-id", ID_CHARS);

type TokenDetail = {
  id: string;
  type: string;
  status: string;
  idempotencyKey?: string | null;
  userProvidedIdempotencyKey: boolean;
  idempotencyKeyExpiresAt?: Date | null;
  output?: string | null;
  outputType: string | null;
  outputIsError: boolean;
  timeoutAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  tags: string[];
};

/**
 * A wait.for or wait.until's time is when it is scheduled to end; a token's is its timeout. A note
 * only for what the times alone do not show: an early end, or a timeout.
 */
function scheduleLine(token: TokenDetail, at: Date): string {
  const done = token.completedAt;
  const early = done ? done.getTime() < at.getTime() : false;
  if (token.type === "DATETIME") {
    return `Scheduled to end: ${iso(at)}${early ? " (it was ended early)" : ""}`;
  }
  const note =
    token.status === "TIMED_OUT"
      ? early
        ? " (it was timed out before this time)"
        : " (it timed out)"
      : early
        ? " (it completed before this timeout)"
        : "";
  return `Timeout: ${iso(at)}${note}`;
}

function renderOutput(token: TokenDetail): string[] {
  if (token.output === undefined || token.output === null) return [];
  const label = token.outputIsError ? "Output (an error)" : "Output";
  if (token.outputType === "application/store") {
    return [`${label}: too large to store inline; open the waitpoint in the dashboard to read it.`];
  }
  return [
    `${label}: ${untrusted(token.output, "waitpoint-output", OUTPUT_CHARS)}`,
    ...(token.output.length > OUTPUT_CHARS
      ? [
          `The output was cut at ${OUTPUT_CHARS.toLocaleString("en-US")} of ${token.output.length.toLocaleString("en-US")} characters; open the waitpoint in the dashboard to read all of it.`,
        ]
      : []),
  ];
}

const renderRun = (run: ConnectedRun) =>
  run.status === undefined || run.taskIdentifier === undefined
    ? `- ${runId(run.friendlyId)}`
    : `- ${runId(run.friendlyId)} | status ${RUN_STATUS.test(run.status) ? run.status : untrusted(run.status, "waitpoint-run-status", ID_CHARS)} | task ${untrusted(run.taskIdentifier, "waitpoint-run-task", ID_CHARS)}`;

export function renderTokenDetail(
  token: TokenDetail,
  runs: ConnectedRun[],
  withRuns: boolean
): string {
  const key = token.userProvidedIdempotencyKey && token.idempotencyKey;
  return [
    `Waitpoint ${waitpointId(token.id)}`,
    `Type: ${TYPES.has(token.type) ? token.type : untrusted(token.type, "waitpoint-type", ID_CHARS)}`,
    `Status: ${status(token.status)}`,
    `Created: ${iso(token.createdAt)}`,
    ...(token.timeoutAt ? [scheduleLine(token, token.timeoutAt)] : []),
    ...(token.completedAt ? [`Completed: ${iso(token.completedAt)}`] : []),
    ...(key
      ? [
          `Idempotency key: ${untrusted(key, "waitpoint-idempotency-key", KEY_CHARS)}${
            token.idempotencyKeyExpiresAt ? ` (expires ${iso(token.idempotencyKeyExpiresAt)})` : ""
          }`,
        ]
      : []),
    `Tags: ${token.tags.length > 0 ? tagList(token.tags) : "none"}`,
    ...renderOutput(token),
    runs.length === 0
      ? "Runs: none found waiting on it."
      : `Runs that waited on it${runs.length >= 5 ? " (the first 5)" : ""}:`,
    ...runs.map(renderRun),
    ...(runs.length > 0 && !withRuns
      ? ["Each run's status and task: not shown, this needs read:runs"]
      : []),
  ].join("\n");
}
