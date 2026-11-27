import { isRunFriendlyId } from "~/components/dashboard-agent/run-id";
import { BATCH_ID, BATCH_LIST_CURSOR, BATCH_STATUSES } from "../schemas/batches";
import { untrusted } from "./logFields";
import { formatStatus } from "./runs";

const ID_CHARS = 128;
const KEY_CHARS = 256;
const ERROR_CHARS = 500;
const LISTED_ERRORS = 20;
export const ITEMS_CHARS = 40_000;

const STATUSES = new Set<string>(BATCH_STATUSES);
const RUN_STATUS = /^[A-Z_]{1,32}$/;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const batchId = (id: string) => (BATCH_ID.test(id) ? id : untrusted(id, "batch-id", ID_CHARS));
const runId = (id: string) =>
  id.length <= ID_CHARS && isRunFriendlyId(id) ? id : untrusted(id, "batch-run-id", ID_CHARS);
const status = (value: string) =>
  STATUSES.has(value) ? value : untrusted(value, "batch-status", ID_CHARS);

type BatchRow = {
  friendlyId: string;
  status: string;
  runCount: number;
  batchVersion: string;
  createdAt: string;
  finishedAt?: string;
};

export function renderBatchRow(row: BatchRow): string {
  return [
    `- ${batchId(row.friendlyId)}`,
    `status ${status(row.status)}`,
    plural(row.runCount, "run"),
    `version ${row.batchVersion === "runengine:v2" ? "v2" : "v1"}`,
    `created ${row.createdAt}`,
    ...(row.finishedAt ? [`finished ${row.finishedAt}`] : []),
  ].join(" | ");
}

export const renderBatchCursor = (cursor: string | undefined) =>
  cursor && BATCH_LIST_CURSOR.test(cursor) ? cursor : undefined;

type BatchError = {
  index: number;
  taskIdentifier: string;
  error: string;
  errorCode: string | null;
};

export type BatchDetail = {
  friendlyId: string;
  status: string;
  isV2: boolean;
  runCount: number;
  successfulRunCount: number;
  failedRunCount: number;
  idempotencyKey: string | null;
  createdAt: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
  finishedAt?: string;
  errors: BatchError[];
};

export function renderBatchDetail(batch: BatchDetail): string[] {
  const lines = [
    `Batch ${batchId(batch.friendlyId)}`,
    `Status: ${status(batch.status)}${!batch.isV2 && batch.status === "COMPLETED" ? " (legacy batch: its runs may not have finished)" : ""}`,
    `Version: ${batch.isV2 ? "v2 (Run Engine)" : "v1 (Legacy)"}`,
    `Total runs: ${batch.runCount}`,
    ...(batch.isV2
      ? [
          `Successfully created: ${batch.successfulRunCount}`,
          `Failed to create: ${batch.failedRunCount}`,
        ]
      : []),
    ...(batch.idempotencyKey
      ? [`Idempotency key: ${untrusted(batch.idempotencyKey, "batch-idempotency-key", KEY_CHARS)}`]
      : []),
    `Created: ${batch.createdAt}`,
    ...(batch.processingStartedAt ? [`Processing started: ${batch.processingStartedAt}`] : []),
    ...(batch.processingCompletedAt
      ? [`Processing completed: ${batch.processingCompletedAt}`]
      : []),
    `Finished: ${batch.finishedAt ?? "not yet"}`,
  ];
  if (batch.errors.length === 0) return lines;

  const shown = batch.errors.slice(0, LISTED_ERRORS);
  return [
    ...lines,
    `Run creation errors (${batch.errors.length}):`,
    ...shown.map(
      (e) =>
        `- item #${e.index} task ${untrusted(e.taskIdentifier, "batch-error-task", ID_CHARS)}${
          e.errorCode ? ` code ${untrusted(e.errorCode, "batch-error-code", ID_CHARS)}` : ""
        }: ${untrusted(e.error, "batch-error", ERROR_CHARS)}`
    ),
    ...(batch.errors.length > shown.length
      ? [
          `Showing the first ${LISTED_ERRORS} run creation errors; open the batch in the dashboard for the rest.`,
        ]
      : []),
  ];
}

export type BatchItemRun = {
  friendlyId: string;
  status: string;
  taskIdentifier: string;
  error: unknown;
};

function errorText(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (typeof error === "object" && !Array.isArray(error)) {
    const { name, type, message } = error as Record<string, unknown>;
    if (typeof message === "string") {
      const label = typeof name === "string" ? name : typeof type === "string" ? type : "Error";
      return `${label}: ${message}`;
    }
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** Names the batch asked for and where to find the right id, only in this environment. */
export const batchNotFound = (id: string) =>
  `Batch ${batchId(id)} was not found in this environment. Use list_batches to see the batches in this environment.`;

export const renderBatchItemId = (id: string) => `- ${runId(id)}`;

export function renderBatchItem(id: string, run: BatchItemRun | undefined): string {
  if (!run) return `- ${runId(id)} | no run found in this environment`;
  const error = errorText(run.error);
  return [
    `- ${runId(run.friendlyId)}`,
    `status ${RUN_STATUS.test(run.status) ? formatStatus(run.status) : untrusted(run.status, "batch-run-status", ID_CHARS)}`,
    `task ${untrusted(run.taskIdentifier, "batch-run-task", ID_CHARS)}`,
    ...(error ? [`error ${untrusted(error, "batch-run-error", ERROR_CHARS)}`] : []),
  ].join(" | ");
}
