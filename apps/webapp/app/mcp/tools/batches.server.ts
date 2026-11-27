import { boundedIn } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import {
  $replica,
  prisma,
  runOpsLegacyReplicaClient,
  runOpsNewReplicaClient,
  runOpsSplitReadEnabled,
  type PrismaClientOrTransaction,
} from "~/db.server";
import { CURRENT_API_VERSION } from "~/api/versions";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { BatchListPresenter } from "~/presenters/v3/BatchListPresenter.server";
import { BatchPresenter } from "~/presenters/v3/BatchPresenter.server";
import { logger } from "~/services/logger.server";
import { runOpsNonAliasedShardReplicas } from "~/v3/runOpsMigration/shardHandles.server";
import { runStore } from "~/v3/runStore.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import {
  type BatchDetail,
  type BatchItemRun,
  batchNotFound,
  ITEMS_CHARS,
  renderBatchCursor,
  renderBatchDetail,
  renderBatchItem,
  renderBatchItemId,
  renderBatchRow,
} from "./format/batches";
import { plainError } from "./format/insights";
import { READ_BUDGET_MS, startReadBudget, stoppedText } from "./readBudget.server";
import { GetBatchInput, ListBatchesInput } from "./schemas/batches";

const auth = { action: "read", subject: "batch" } as const;
const DEFAULT_PERIOD = "7d";

/** The window searched, saying when it is the default, since an empty default window looks like "no batches". */
const windowText = (period: string | undefined) =>
  period ? `the last ${period}` : `the last ${DEFAULT_PERIOD} (the default period)`;
const WIDER_PERIOD = "90d";

/** Suggests a wider window only when the one searched is narrower. */
const widerHint = (period: string) =>
  (parseDuration(period) ?? 0) < parseDuration(WIDER_PERIOD)!
    ? ` Pass a longer period, such as ${WIDER_PERIOD}, to look further back.`
    : "";

const BATCH_READ_FAILED = "Could not read batches. Try again later.";

function logBatchToolError(tool: string, error: unknown) {
  logger.error("MCP batch tool failed", {
    tool,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

function listBatches(input: ListBatchesInput, projectId: string, environmentId: string) {
  const presenter = new BatchListPresenter(undefined, undefined, {
    runOpsNew: runOpsNewReplicaClient,
    runOpsLegacyReplica: runOpsLegacyReplicaClient,
    controlPlaneReplica: $replica as unknown as PrismaClientOrTransaction,
    shardReplicas: runOpsNonAliasedShardReplicas,
    splitEnabled: runOpsSplitReadEnabled,
  });
  return presenter.call({
    projectId,
    environmentId,
    statuses: input.statuses,
    period: input.period ?? DEFAULT_PERIOD,
    cursor: input.cursor,
    pageSize: input.limit,
  });
}

async function readBatch(batchId: string, environmentId: string): Promise<BatchDetail | null> {
  try {
    return await new BatchPresenter().call({ environmentId, batchId });
  } catch (error) {
    if (error instanceof Error && error.message === "Batch not found") return null;
    throw error;
  }
}

type Items = { ids: string[]; total: number; runs?: Map<string, BatchItemRun> };

/** Each run's status, task and error are only read when the caller may read runs. */
async function readItems(
  batchId: string,
  environmentId: string,
  offset: number,
  limit: number,
  withRuns: boolean
): Promise<Items | "unlisted"> {
  const row =
    (await runStore.findBatchTaskRunByFriendlyId(batchId, environmentId)) ??
    (await runStore.findBatchTaskRunByFriendlyId(batchId, environmentId, undefined, prisma));
  const runIds = row?.runIds ?? [];
  if (runIds.length > 0 && !runIds.every((id) => id.startsWith("run_"))) return "unlisted";
  const ids = runIds.slice(offset, offset + limit);
  if (!withRuns) return { ids, total: runIds.length };
  const runs =
    ids.length === 0
      ? []
      : await runStore.findRuns({
          where: { friendlyId: { in: boundedIn(ids) }, runtimeEnvironmentId: environmentId },
          select: { friendlyId: true, status: true, taskIdentifier: true, error: true },
        });
  return {
    ids,
    total: runIds.length,
    runs: new Map(
      runs.map((run) => [
        run.friendlyId,
        {
          ...run,
          status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(run.status, CURRENT_API_VERSION),
        },
      ])
    ),
  };
}

const RUNS_HIDDEN = "not shown, this needs read:runs";

const FAILED_ITEMS =
  "Items whose run could not be created are not in this list; they are under Run creation errors.";

function renderItems(batch: BatchDetail, items: Items, offset: number): string[] {
  const failedNote = batch.errors.length > 0 || batch.failedRunCount > 0 ? [FAILED_ITEMS] : [];
  if (items.total === 0) {
    return batch.isV2 && !batch.processingCompletedAt
      ? [
          "Created runs: they are recorded on the batch when it finishes creating them; until then use list_runs with the batch filter.",
        ]
      : ["Created runs: none.", ...failedNote];
  }
  if (items.ids.length === 0) {
    return [`Created runs: none after ${offset}; the batch has ${items.total}.`];
  }
  const lines: string[] = [];
  let used = 0;
  for (const id of items.ids) {
    const line = items.runs ? renderBatchItem(id, items.runs.get(id)) : renderBatchItemId(id);
    if (lines.length > 0 && used + line.length > ITEMS_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  const next = offset + lines.length;
  return [
    items.runs
      ? `Created runs ${offset + 1}-${next} of ${items.total}, in the order the batch recorded them (run, status, task, error):`
      : `Created runs ${offset + 1}-${next} of ${items.total}, in the order the batch recorded them:`,
    ...lines,
    ...(items.runs ? [] : [`Each run's status, task and error: ${RUNS_HIDDEN}`]),
    ...failedNote,
    ...(next < items.total
      ? [`More created runs exist. Pass cursor ${next} to show the next ones.`]
      : []),
  ];
}

export function createBatchesTools({
  readBudgetMs = READ_BUDGET_MS,
}: { readBudgetMs?: number } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "list_batches",
      title: "List Batches",
      description:
        "List the batches of an environment, newest first, like the Batches page in the dashboard: each batch's status, run count, version and when it was created and finished. Filter by status and time period. Pass the returned cursor to list older ones.",
      shape: ListBatchesInput.shape,
      auth,
      run: async (input, ctx) => {
        const budget = startReadBudget(readBudgetMs, ctx.signal);
        const resolved = await budget.read(() => resolveToolEnvironment(ctx));
        if (!resolved.ok) return plainError(stoppedText(resolved));
        const environment = resolved.value;
        if (!environment) return plainError("Environment not found");

        let read;
        try {
          read = await budget.read(() => listBatches(input, environment.projectId, environment.id));
        } catch (error) {
          logBatchToolError("list_batches", error);
          return plainError(BATCH_READ_FAILED);
        }
        if (!read.ok) return plainError(stoppedText(read));
        const list = read.value;

        const window = windowText(input.period);
        if (list.batches.length === 0) {
          return textResult(
            input.cursor
              ? `No older batches in ${window}.`
              : `No batches match these filters in ${window}.${widerHint(input.period ?? DEFAULT_PERIOD)}`
          );
        }
        const next = renderBatchCursor(list.pagination.next);
        return textResult(
          [
            `Found ${list.batches.length} batch${list.batches.length === 1 ? "" : "es"} in ${window}:`,
            ...list.batches.map(renderBatchRow),
            ...(next ? [`More batches exist. Pass cursor ${next} to list older ones.`] : []),
          ].join("\n")
        );
      },
    }),
    defineReadTool({
      name: "get_batch_details",
      title: "Get Batch Details",
      description:
        "Get a batch, like the batch page in the dashboard: its status, run counts, idempotency key, timestamps and run creation errors, then the runs it created, in the order the batch recorded them, with each run's status, task and error, which need read:runs. Shows up to 50 runs per call with a cursor for the next ones; errors are shortened. The ID starts with batch_",
      shape: GetBatchInput.shape,
      auth,
      run: async (input, ctx) => {
        const budget = startReadBudget(readBudgetMs, ctx.signal);
        const resolved = await budget.read(() => resolveToolEnvironment(ctx));
        if (!resolved.ok) return plainError(stoppedText(resolved, "lookup"));
        const environment = resolved.value;
        if (!environment) return plainError("Environment not found");

        const offset = Number(input.cursor ?? 0);
        let read;
        try {
          read = await budget.read(() =>
            Promise.all([
              readBatch(input.batchId, environment.id),
              readItems(
                input.batchId,
                environment.id,
                offset,
                input.limit,
                ctx.ability?.can("read", { type: "runs", envType: environment.type }) ?? false
              ),
            ])
          );
        } catch (error) {
          logBatchToolError("get_batch_details", error);
          return plainError(BATCH_READ_FAILED);
        }
        if (!read.ok) return plainError(stoppedText(read, "lookup"));

        const [batch, items] = read.value;
        if (!batch) return plainError(batchNotFound(input.batchId));

        return textResult(
          [
            ...renderBatchDetail(batch),
            ...(items === "unlisted"
              ? [
                  "Created runs: this older batch does not record its runs in order; use list_runs with the batch filter to see them.",
                ]
              : renderItems(batch, items, offset)),
          ].join("\n")
        );
      },
    }),
  ];
}

export const batchesTools: McpToolDefinition[] = createBatchesTools();
