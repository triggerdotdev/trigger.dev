import { EngineServiceValidationError, type RunEngine } from "@internal/run-engine";
import { BatchTriggerTaskV3RequestBody, TaskRunErrorCodes } from "@trigger.dev/core/v3";
import superjson from "superjson";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { RbacAbility } from "@trigger.dev/rbac";
import { boundedIn, prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { v3BatchPath } from "~/utils/pathBuilder";
import { MCP_REMOTE_TRIGGER_SOURCE } from "~/utils/triggerSource";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { OutOfEntitlementError } from "~/v3/outOfEntitlementError.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { confirmationPreview, PREVIEW_LIMIT } from "../confirm/confirmation.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpSubject } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { dashboardUrl, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, fencedError, staleApproval } from "./defineWrite.server";
import { plainError } from "./format/insights";
import { escapeLayout, escapeText } from "./format/runsEditPreview";
import { READ_BUDGET_MS, startReadBudget } from "./readBudget.server";
import { BATCH_TRIGGER_MAX_ITEMS, BatchTriggerTasksInput } from "./schemas/write";
import { describeConcurrency } from "./tasksWrite.server";

type Item = BatchTriggerTasksInput["items"][number];
type Plan = { preview: string } | { refuse: string };
type CreatedRun = { id: string; taskId: string; reused: boolean; failure?: string };
type CreatedBatch = { id: string; runCount: number; runs: CreatedRun[] | undefined };

const TASK_ID_LIKE = /^[A-Za-z0-9][\w.:/-]{0,127}$/;

const namedTask = (taskId: string) =>
  TASK_ID_LIKE.test(taskId) ? taskId : fenceUntrusted(taskId, "task-id");

const distinctTasks = (items: Item[]) => [...new Set(items.map((item) => item.taskId))];

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function countsPerTask(taskIds: string[]) {
  const counts = new Map<string, number>();
  for (const taskId of taskIds) counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  return [...counts].map(([taskId, count]) => `${escapeText(taskId)} ${count}`).join(", ");
}

/** What the confirmation shows, or why the batch is refused before one exists. */
async function planBatch(
  input: BatchTriggerTasksInput,
  subject: McpSubject | null,
  signal: AbortSignal
): Promise<Plan> {
  if (!subject?.environmentId || !subject.environmentType) {
    return { refuse: "Environment not found" };
  }
  const environment = { id: subject.environmentId, type: subject.environmentType };
  const { read } = startReadBudget(READ_BUDGET_MS, signal);
  const tooSlow = { refuse: "Reading the environment's tasks took too long. Try again." };

  // Primary reads: a promotion the replica has not applied must still make an approval stale.
  const current = await read(() => findCurrentWorkerFromEnvironment(environment, prisma));
  if (!current.ok) return tooSlow;
  const currentVersion = current.value?.version;
  const versions = [
    ...new Set(input.items.flatMap((item) => item.options?.lockToVersion ?? currentVersion ?? [])),
  ];
  const known = await read(() =>
    versions.length === 0
      ? Promise.resolve([])
      : prisma.backgroundWorkerTask.findMany({
          where: {
            runtimeEnvironmentId: environment.id,
            slug: { in: boundedIn(distinctTasks(input.items)) },
            worker: { version: { in: boundedIn(versions) } },
          },
          select: { slug: true, worker: { select: { version: true } } },
        })
  );
  if (!known.ok) return tooSlow;

  const found = new Set(known.value.map((task) => `${task.worker.version}\n${task.slug}`));
  for (const item of input.items) {
    const version = item.options?.lockToVersion ?? currentVersion;
    if (version === undefined) {
      return {
        refuse: `${input.environment} has no current version yet, so no task can be triggered. Deploy, or run the dev command for the dev environment. Nothing was triggered.`,
      };
    }
    if (!found.has(`${version}\n${item.taskId}`)) {
      return {
        refuse: `Task ${namedTask(item.taskId)} was not found in version ${version} of ${input.environment}, see list_tasks; nothing was triggered.`,
      };
    }
  }

  const lines = [
    `batch_trigger_tasks in ${input.branch ? `${input.environment} branch ${escapeText(input.branch)}` : input.environment}: submits ${plural(input.items.length, "item")} in one batch. Each item creates a run, unless its idempotency or debounce key returns an existing run.`,
    `Runs per task: ${countsPerTask(input.items.map((item) => item.taskId))}`,
    `Current version: ${currentVersion ?? "none"}`,
  ];
  const itemLines = await Promise.all(
    input.items.map(async (item, index) => {
      const shown = await confirmationPreview(
        "trigger_task",
        true,
        { taskId: item.taskId, payload: item.payload, options: item.options },
        subject
      );
      const change = describeConcurrency(item.options?.concurrency);
      return [`${index + 1}. ${escapeLayout(shown.preview)}`, ...(change ? [`   ${change}`] : [])];
    })
  );
  const preview = [...lines, ...itemLines.flat()].join("\n");
  return preview.length > PREVIEW_LIMIT ? { refuse: TOO_LARGE } : { preview };
}

// Strings and null as super+json: the failed-item path stores a string raw and null as "".
// Everything else as plain JSON, which superjson rejects for keys like __proto__.
const encodePayload = (value: unknown) =>
  typeof value === "string" || value === null
    ? { payload: superjson.stringify(value), payloadType: "application/super+json" }
    : { payload: value, payloadType: undefined };

const TOO_LARGE = `This batch is too large to confirm in full (the limit is ${PREVIEW_LIMIT} characters). Send fewer items or smaller payloads or metadata; nothing changed.`;

async function triggerBatch(
  environment: AuthenticatedEnvironment,
  body: BatchTriggerTaskV3RequestBody
): Promise<CreatedBatch> {
  const { RunEngineBatchTriggerService } = await import("~/runEngine/services/batchTrigger.server");
  const { determineRealtimeStreamsVersion } =
    await import("~/services/realtime/v1StreamsGlobal.server");
  const { engine } = await import("~/v3/runEngine.server");

  const batch = await new RunEngineBatchTriggerService().call(environment, body, {
    traceContext: { external: {} },
    realtimeStreamsVersion: determineRealtimeStreamsVersion(
      undefined,
      environment.organization.streamBasinName
    ),
    triggerSource: MCP_REMOTE_TRIGGER_SOURCE,
    triggerAction: "trigger",
  });

  // The primary: the replica may not have the batch or its runs yet.
  const runs = await readCreatedRuns(engine.runStore, batch.id, environment.id).catch(
    (error: unknown) => {
      logger.error("MCP batch trigger read-back failed", { batchId: batch.id, error });
      return undefined;
    }
  );
  return { id: batch.id, runCount: batch.runCount, runs };
}

async function readCreatedRuns(
  runStore: RunEngine["runStore"],
  batchId: string,
  environmentId: string
): Promise<CreatedRun[]> {
  const stored = await runStore.findBatchTaskRunByFriendlyId(
    batchId,
    environmentId,
    undefined,
    prisma
  );
  const runIds = stored?.runIds ?? [];
  const rows = await runStore.findRuns(
    {
      where: { friendlyId: { in: boundedIn(runIds) }, runtimeEnvironmentId: environmentId },
      select: { friendlyId: true, taskIdentifier: true, error: true, batchId: true },
    },
    prisma
  );
  const byId = new Map(rows.map((row) => [row.friendlyId, row]));
  return runIds.map((id, index) => {
    const row = byId.get(id);
    const error = row?.error as { code?: string; message?: string } | null | undefined;
    return {
      id,
      taskId: row?.taskIdentifier ?? "",
      // A run this batch created carries its id; an idempotency or debounce hit returns an older run.
      reused: runIds.indexOf(id) < index || (row !== undefined && row.batchId !== stored?.id),
      failure:
        error?.code === TaskRunErrorCodes.BATCH_ITEM_COULD_NOT_TRIGGER ? error.message : undefined,
    };
  });
}

/** Which of its keys could have returned an existing run for this item. */
function matchedKey(item: Item | undefined) {
  const idempotency = item?.options?.idempotencyKey !== undefined;
  const debounce = item?.options?.debounce !== undefined;
  if (idempotency && !debounce) return "its idempotency key";
  if (debounce && !idempotency) return "its debounce key";
  return "its idempotency or debounce key";
}

/** Follow-ups the caller can use, by what its grant lets it read. */
const FOLLOW_UP = {
  batch: (id: string) =>
    `get_batch_details with ${id} shows the runs the batch recorded, including reused ones.`,
  runs: (id: string) =>
    `list_runs with batch ${id} lists the runs this batch created, not older runs it reused; read those with get_run_details.`,
};

const followUpFor = (
  ability: RbacAbility | undefined,
  envType: RuntimeEnvironmentType
): keyof typeof FOLLOW_UP | undefined =>
  ability?.can("read", { type: "batch", envType })
    ? "batch"
    : ability?.can("read", { type: "runs", envType })
      ? "runs"
      : undefined;

export function describeCreated(
  batch: CreatedBatch,
  url: string,
  items: Item[] = [],
  followUp?: keyof typeof FOLLOW_UP
): string {
  const created = [
    `Batch ${batch.id} created with ${plural(batch.runCount, "item")}.`,
    ...(followUp ? [FOLLOW_UP[followUp](batch.id)] : []),
  ].join(" ");
  if (!batch.runs) {
    return [
      created,
      "Its run IDs could not be read right now.",
      `View the batch in the dashboard: ${url}`,
    ].join("\n");
  }
  const listed = batch.runs.map((run) => run.id).join(", ");
  if (batch.runs.length !== batch.runCount) {
    // Run ids only line up with items when every item has one.
    return [
      created,
      `${plural(batch.runs.length, "run")} listed for the ${batch.runCount} items, not necessarily in item order. Runs created for the other items may not be listed here.${listed ? ` Runs listed: ${listed}` : ""}`,
      `View the batch in the dashboard: ${url}`,
    ].join("\n");
  }
  const notes = batch.runs.flatMap((run, index) => {
    const item = `Item ${index + 1} (task ${namedTask(run.taskId)})`;
    if (run.failure !== undefined) {
      return [
        `${item} could not be triggered: ${fenceUntrusted(run.failure, "batch-item-error")} Its run ${run.id} was created as failed.`,
      ];
    }
    return run.reused
      ? [`${item} returned the existing run ${run.id}: ${matchedKey(items[index])} matched.`]
      : [];
  });
  return [
    created,
    `Runs, one per item in order: ${listed}`,
    ...notes,
    `View the batch in the dashboard: ${url}`,
    "The runs execute in the background. Do not wait for them unless the user asked you to.",
  ].join("\n");
}

export const batchTriggerTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "batch_trigger_tasks",
    title: "Batch Trigger Tasks",
    description: `Trigger up to ${BATCH_TRIGGER_MAX_ITEMS} runs in one batch, each item with its own task, payload and the same options as trigger_task. Every call needs the user's approval, which shows every item. Returns the batch ID and the run IDs. The runs execute in the background.`,
    shape: BatchTriggerTasksInput.shape,
    approval: "required",
    // As the public batch route: batchTrigger on every task; access tokens get it from write:tasks.
    auth: {
      action: "batchTrigger",
      subject: "tasks",
      scope: "write:tasks",
      resourceId: (input: { items?: Item[] }) => input.items?.[0]?.taskId,
    },
    confirm: {
      precheck: (input, ability, subject) => {
        const denied = distinctTasks(input.items).find(
          (id) =>
            !ability?.can("batchTrigger", { type: "tasks", id, envType: subject?.environmentType })
        );
        return denied === undefined
          ? undefined
          : {
              refuse: `Batch triggering requires the batchTrigger permission on the ${namedTask(denied)} task (write:tasks for an access token). Nothing was triggered.`,
            };
      },
      preview: async (input, subject) => {
        const plan = await planBatch(input, subject, new AbortController().signal);
        return "refuse" in plan ? plan : plan.preview;
      },
    },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return plainError("Environment not found");

      const plan = await planBatch(input, ctx.subject, ctx.signal);
      if ("refuse" in plan) return plainError(plan.refuse);
      const stale = staleApproval(ctx, plan.preview, plainError);
      if (stale) return stale;

      const body = BatchTriggerTaskV3RequestBody.safeParse({
        items: input.items.map((item) => {
          const { payload, payloadType } = encodePayload(item.payload);
          return {
            task: item.taskId,
            payload,
            options: { ...item.options, payloadType },
          };
        }),
      });
      if (!body.success) return fencedError(body.error.message, "trigger-error");

      let batch: Awaited<ReturnType<typeof triggerBatch>>;
      try {
        batch = await triggerBatch(environment, body.data);
      } catch (error) {
        if (
          error instanceof ServiceValidationError ||
          error instanceof EngineServiceValidationError ||
          error instanceof OutOfEntitlementError
        ) {
          return fencedError(error.message, "trigger-error");
        }
        throw error;
      }

      return textResult(
        describeCreated(
          batch,
          dashboardUrl(
            v3BatchPath(environment.organization, environment.project, environment, {
              friendlyId: batch.id,
            })
          ),
          input.items,
          followUpFor(ctx.ability, environment.type)
        )
      );
    },
  }),
];
