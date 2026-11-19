import { createRedisClient, type RedisOptions } from "@internal/redis";
import { RedisSnapshotStore } from "@internal/run-store";
import { BatchId, generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient, TaskRun } from "@trigger.dev/database";
import type { EventBusEventArgs } from "../../eventBus.js";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import type { RunEngine } from "../../index.js";
import type { LockRetryConfig } from "../../locking.js";
import { parseEdgeField, runBlockKeys } from "../../waitpointCoordinator/keys.js";
import { WaitpointStoreCoordinator } from "../../waitpointCoordinator/storeCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../setup.js";
import { makeEngine, triggerRun, dequeueAndStart } from "./storeRunWaitpointLifecycleFixtures.js";
import { waitpointStoreBarrier } from "./waitpointStoreBarrier.js";

export const newFriendlyId = () => `run_${generateRunOpsIdV2("a")}`;

const PRODUCER_COMMAND_TIMEOUT_MS = 500;

/** How a store command fails. */
export type FaultMode = "throw" | "replyLost" | "stall";

type Plan = {
  /** Fail the `at`th store command from now. */
  at?: number;
  /** Or fail the first command for which this is true. */
  when?: () => Promise<boolean>;
  mode: FaultMode;
  /** Fail every later command too: the producer dies. */
  from?: boolean;
  /** Run this instead of failing the command, then let it through. */
  run?: () => Promise<void>;
};

/**
 * Fault injection through the store's own `beforeCommand` hook. "throw" fails the command before
 * it is sent. "replyLost" and "stall" hand the command to the wire barrier: the reply is held until
 * the command times out, or the request is held until the test releases it.
 */
function storeFaults(barrier: Awaited<ReturnType<typeof waitpointStoreBarrier>>) {
  let commands = 0;
  let plan: Plan | undefined;
  let fired = false;
  let stalled: (() => void) | undefined;
  let stall = new Promise<void>((resolve) => (stalled = resolve));
  return {
    get commands() {
      return commands;
    },
    get fired() {
      return fired;
    },
    /** Resolves once a stalled command is held. */
    get stall() {
      return stall;
    },
    arm(next: Plan) {
      commands = 0;
      fired = false;
      plan = next;
      stall = new Promise<void>((resolve) => (stalled = resolve));
    },
    disarm() {
      plan = undefined;
    },
    beforeCommand: async () => {
      commands++;
      if (!plan) return;
      const hit = plan.when ? await plan.when() : commands === plan.at;
      if (!hit && !(fired && plan.from)) return;
      fired = true;
      if (plan.run) {
        const run = plan.run;
        plan = undefined;
        return run();
      }
      const mode = plan.mode;
      if (!plan.from) plan = undefined;
      if (mode === "throw") throw new Error("injected store fault");
      barrier.pause(() => true, mode === "replyLost" ? "reply" : "request");
      if (mode === "stall") {
        void (async () => {
          while (!barrier.held) await setTimeout(5);
          stalled?.();
        })();
      } else {
        // Hold the reply until the command times out, then let the connection move on.
        void (async () => {
          while (!barrier.held) await setTimeout(5);
          await setTimeout(PRODUCER_COMMAND_TIMEOUT_MS + 100);
          barrier.release();
        })();
      }
    },
  };
}

/**
 * Two engines on one database and Redis: a producer whose store commands can fail, and a healthy
 * engine whose worker runs recovery and which takes the BatchQueue's retries.
 */
export async function storeBatchHarness(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  opts: {
    recoveryDelayMs?: number;
    stallTimeoutMs?: number;
    /** The producer's lock retry: shrink it to make an attempt lose a held parent lock quickly. */
    lockRetry?: LockRetryConfig;
    /** One environment per database: pass the first harness's to the next. */
    env?: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;
  } = {}
) {
  const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const store = new WaitpointStoreCoordinator({ redisOptions });
  const barrier = await waitpointStoreBarrier(redisOptions);
  const faults = storeFaults(barrier);
  const producerStore = new WaitpointStoreCoordinator({
    redisOptions: {
      ...barrier.redisOptions,
      commandTimeout: opts.stallTimeoutMs ?? PRODUCER_COMMAND_TIMEOUT_MS,
    },
    beforeCommand: faults.beforeCommand,
  });
  const recoveryDelayMs = opts.recoveryDelayMs ?? 200;
  let storeEnabled = true;
  const isWaitpointStoreEnabled = () => storeEnabled;
  // New RUN waitpoints mint in Postgres while false, e.g. a capability flip mid-batch.
  let runMintReady = true;
  const isCapabilityReady = () => runMintReady;
  const producer = makeEngine(prisma, redisOptions, {
    store: producerStore,
    snapshotStore,
    workerDisabled: true,
    recoveryDelayMs,
    runLockRetryConfig: opts.lockRetry,
    isWaitpointStoreEnabled,
    isCapabilityReady,
  });
  const engine = makeEngine(prisma, redisOptions, {
    store,
    snapshotStore,
    recoveryDelayMs,
    isWaitpointStoreEnabled,
    isCapabilityReady,
  });
  const redis = createRedisClient(redisOptions);
  const failed: EventBusEventArgs<"runFailed">[0][] = [];
  for (const e of [producer, engine])
    e.eventBus.on("runFailed", (event) => void failed.push(event));
  let env = opts.env;
  if (!env) {
    env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
  }
  return {
    prisma,
    env,
    store,
    redis,
    barrier,
    faults,
    producer,
    engine,
    failed,
    /** Turn the organization's waitpoint store rollout on or off for both engines. */
    setStoreEnabled(enabled: boolean) {
      storeEnabled = enabled;
    },
    setRunMintReady(ready: boolean) {
      runMintReady = ready;
    },
    async close() {
      faults.disarm();
      barrier.release();
      await producer.quit();
      await engine.quit();
      await producerStore.quit();
      await store.quit();
      await barrier.close();
      await snapshotStore.quit();
      redis.disconnect();
    },
  };
}
export type StoreBatchHarness = Awaited<ReturnType<typeof storeBatchHarness>>;

/** A started parent blocked on a native batch of `count` items. */
export async function setupBatchParent(h: StoreBatchHarness, count: number) {
  const { engine, prisma, env } = h;
  const parent = await triggerRun(engine, env, prisma, {
    friendlyId: newFriendlyId(),
    taskIdentifier: "parent-task",
  });
  await dequeueAndStart(engine, `parent-${parent.id}`);
  const { id: batchId, friendlyId } = BatchId.generate();
  await prisma.batchTaskRun.create({
    data: {
      id: batchId,
      friendlyId,
      runtimeEnvironmentId: env.id,
      runCount: count,
      batchVersion: "runengine:v2",
      // The BatchQueue counts items as they are processed; see expectBatchResolvedOnce.
      successfulRunCount: 0,
    },
  });
  const header = await engine.blockRunWithCreatedBatch({
    runId: parent.id,
    batchId,
    environmentId: env.id,
    projectId: env.project.id,
    organizationId: env.organization.id,
  });
  return { parent, batchId, headerId: header!.id, count };
}
export type BatchParent = Awaited<ReturnType<typeof setupBatchParent>>;

export const itemPayload = (index: number) => JSON.stringify({ i: index });

export function triggerItem(
  h: StoreBatchHarness,
  on: RunEngine,
  b: BatchParent,
  index: number,
  extra: Partial<Parameters<typeof triggerRun>[3]> = {}
) {
  return triggerRun(on, h.env, h.prisma, {
    friendlyId: newFriendlyId(),
    taskIdentifier: "child-task",
    parentTaskRunId: b.parent.id,
    resumeParentOnCompletion: true,
    batch: { id: b.batchId, index },
    payload: itemPayload(index),
    ...extra,
  });
}

/** The webapp's cached-idempotency attach of an existing run to a batch position. */
export async function attachCachedRun(
  h: StoreBatchHarness,
  on: RunEngine,
  b: BatchParent,
  index: number,
  existing: TaskRun
): Promise<TaskRun> {
  const { env } = h;
  const waitpoint = await on.getOrCreateRunWaitpoint({
    runId: existing.id,
    projectId: env.project.id,
    environmentId: env.id,
    blockingParentRunId: b.parent.id,
    organizationId: env.organization.id,
    blockingViaBatch: true,
    blockingBatchId: b.batchId,
  });
  const blockOperation = await on.waitpointSystem.buildStoreBlockOperation({
    runId: b.parent.id,
    waitpointId: waitpoint.id,
    organizationId: env.organization.id,
  });
  return on.blockRunWithCachedRun({
    cachedRun: existing,
    runId: b.parent.id,
    waitpoints: waitpoint.id,
    batch: { id: b.batchId, index },
    projectId: env.project.id,
    organizationId: env.organization.id,
    ...(blockOperation ? { blockOperation } : {}),
  });
}

/** The BatchQueue's pre-failed fallback once an item has used up its attempts. */
export function createFailedItem(
  h: StoreBatchHarness,
  on: RunEngine,
  b: BatchParent,
  index: number,
  friendlyId = newFriendlyId()
) {
  return on.createFailedTaskRun({
    friendlyId,
    environment: h.env,
    taskIdentifier: "child-task",
    payload: itemPayload(index),
    error: { type: "STRING_ERROR", raw: "could not trigger" },
    parentTaskRunId: b.parent.id,
    resumeParentOnCompletion: true,
    batch: { id: b.batchId, index },
  });
}

/** The parent's batch position fields: `@header#index` in its block's refs hash. */
export async function positionFields(h: StoreBatchHarness, parentRunId: string) {
  return (await h.redis.hkeys(runBlockKeys(parentRunId).refs)).filter((f) => f.startsWith("@"));
}

/**
 * Deliver one item as the BatchQueue does: the first attempt on the producer, then retries with a
 * fresh run id on the healthy engine (6 attempts in all), then the pre-failed fallback. A stalled
 * first attempt counts as failed once it is held. It resumes while the item is being retried: once
 * the retry settles, or sooner if the stall holds a lock the retry needs.
 */
export async function deliverItem(
  h: StoreBatchHarness,
  attempt: (on: RunEngine) => Promise<TaskRun>,
  fallback: (on: RunEngine) => Promise<TaskRun>
): Promise<TaskRun> {
  // A stalled command blocks the producer's connection, so later items start on the healthy engine.
  const onProducer = !h.barrier.held;
  const first = attempt(onProducer ? h.producer : h.engine);
  const settled = await Promise.race([
    first.then(
      (run) => ({ run }),
      (error: unknown) => ({ error })
    ),
    ...(onProducer ? [h.faults.stall.then(() => ({ stalled: true as const }))] : []),
  ]);
  if ("run" in settled) return settled.run;
  const retries = (async () => {
    for (let retry = 1; retry < 6; retry++) {
      const [error, run] = await attempt(h.engine).then(
        (run) => [undefined, run] as const,
        (error: unknown) => [error, undefined] as const
      );
      if (!error) return run!;
    }
    return fallback(h.engine);
  })();
  if (!("stalled" in settled)) return retries;
  void first.catch(() => {});
  await Promise.race([retries.catch(() => {}), setTimeout(1_000)]);
  h.barrier.release();
  await first.catch(() => {});
  return retries;
}

/**
 * Execute every child that reaches the queue until the parent resumes. Returns how many times each
 * run was started. Also runs the webapp's batch completion check, which a cached run cannot.
 */
async function runChildrenUntilParentResumes(
  h: StoreBatchHarness,
  b: BatchParent,
  lateRecovery?: boolean
) {
  const { engine, prisma, env } = h;
  const executions = new Map<string, number>();
  const execute = async () => {
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "children",
      workerQueue: "main",
      blockingPopTimeoutSeconds: 0.2,
    });
    for (const message of dequeued) {
      executions.set(message.run.id, (executions.get(message.run.id) ?? 0) + 1);
      const attempt = await engine.startRunAttempt({
        runId: message.run.id,
        snapshotId: message.snapshot.id,
      });
      const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: message.run.id } });
      await engine.completeRunAttempt({
        runId: message.run.id,
        snapshotId: attempt.snapshot.id,
        completion: {
          id: message.run.id,
          ok: true,
          output: run.payload,
          outputType: "application/json",
        },
      });
    }
    return dequeued.map((message) => message.run.id);
  };
  // Every edge the parent's block held while it waited: the block is cleared when it resumes.
  const edges = new Set<string>();
  let positions = 0;
  const readEdges = async () => {
    positions = Math.max(positions, (await positionFields(h, b.parent.id)).length);
    for (const field of await h.redis.hkeys(runBlockKeys(b.parent.id).edge)) edges.add(field);
    for (const edge of await prisma.taskRunWaitpoint.findMany({
      where: { taskRunId: b.parent.id, batchIndex: { not: null } },
    }))
      edges.add(`${edge.waitpointId}#${edge.batchIndex}`);
  };
  const started = performance.now();
  const deadline = started + 30_000;
  let recoveryFired = false;
  let data = await engine.getRunExecutionData({ runId: b.parent.id });
  while (data?.snapshot.executionStatus !== "EXECUTING" && performance.now() < deadline) {
    // Delayed recovery still comes due: a registration only recovery can finish waits for it.
    if (lateRecovery && !recoveryFired && performance.now() - started > 2_000) {
      recoveryFired = true;
      const children = await prisma.taskRun.findMany({ where: { parentTaskRunId: b.parent.id } });
      await fireRecoveryNow(
        h,
        children.map((c) => c.id)
      );
    }
    await readEdges();
    await execute();
    await engine.tryCompleteBatch({ batchId: b.batchId, organizationId: env.organization.id });
    data = await engine.getRunExecutionData({ runId: b.parent.id });
  }
  expect(data?.snapshot.executionStatus, "parent never resumed").toBe("EXECUTING");
  // The SDK resolves batch position `index` with the RUN waitpoint carrying that index.
  const results = data!.completedWaitpoints
    .filter((w) => w.type === "RUN")
    .map((w) => ({
      index: w.index,
      output: w.output,
      isError: w.outputIsError,
      runId: w.completedByTaskRun?.id,
    }))
    .sort((x, y) => x.index! - y.index!);
  return { executions, results, execute, edges, positions };
}

async function recoveryJobIds(h: StoreBatchHarness, runIds: string[]) {
  const ids: string[] = [];
  for (const id of runIds)
    if (await h.engine["worker"].getJob(`recoverRunWaitpoint:${id}`))
      ids.push(`recoverRunWaitpoint:${id}`);
  return ids;
}

/** Make every pending recovery job for these runs due now. */
export async function fireRecoveryNow(h: StoreBatchHarness, runIds: string[]) {
  for (const id of await recoveryJobIds(h, runIds))
    await h.engine["worker"].reschedule(id, new Date());
}

/**
 * The batch contract: the parent resumed; one result per index, carrying that index's payload or,
 * for `failedIndexes`, an error; no run started twice and at most one started run per index; every
 * other child terminal; no recovery left; nothing queued; one position owner and one raw parent
 * edge per index while open, and no position fields once the block is cleaned up.
 */
export async function expectBatchResolvedOnce(
  h: StoreBatchHarness,
  b: BatchParent,
  opts: {
    lateRecovery?: boolean;
    extraRunIds?: string[];
    ignoreRunIds?: string[];
    failedIndexes?: number[];
    /** Runs whose failure is expected to alert, beyond the batch's own results. */
    alertedRunIds?: string[];
  } = {}
) {
  const { prisma } = h;
  // Every item has been delivered: the batch can complete once its runs finish.
  await prisma.batchTaskRun.update({
    where: { id: b.batchId },
    data: { successfulRunCount: b.count },
  });
  const { executions, results, execute, edges, positions } = await runChildrenUntilParentResumes(
    h,
    b,
    opts.lateRecovery
  );
  // Runs that belong to another trigger, such as a cached run refused a position, run on their own.
  for (const id of opts.ignoreRunIds ?? []) executions.delete(id);
  const children = await prisma.taskRun.findMany({ where: { parentTaskRunId: b.parent.id } });
  const runIds = [...children.map((c) => c.id), ...(opts.extraRunIds ?? [])];
  if (opts.lateRecovery) await fireRecoveryNow(h, runIds);
  const deadline = performance.now() + 20_000;
  while ((await recoveryJobIds(h, runIds)).length && performance.now() < deadline)
    await setTimeout(20);
  expect(await recoveryJobIds(h, runIds), "recovery jobs never finished").toEqual([]);
  const ignored = new Set(opts.ignoreRunIds);
  expect(
    (await execute()).filter((id) => !ignored.has(id)),
    "a child was queued after the parent resumed"
  ).toEqual([]);

  const failed = new Set(opts.failedIndexes ?? []);
  expect(
    results.map((r) => ({ index: r.index, ok: failed.has(r.index!) ? r.isError : r.output })),
    "batch results"
  ).toEqual(
    Array.from({ length: b.count }, (_, i) => ({
      index: i,
      ok: failed.has(i) ? true : itemPayload(i),
    }))
  );
  expect([...executions.values()], "a run executed more than once").toEqual(
    Array(executions.size).fill(1)
  );
  const executedRuns = await prisma.taskRun.findMany({
    where: { id: { in: [...executions.keys()] } },
  });
  expect(executedRuns.map((r) => r.payload).sort(), "executed runs per index").toEqual(
    Array.from({ length: b.count }, (_, i) => i)
      .filter((i) => !failed.has(i))
      .map(itemPayload)
      .sort()
  );
  for (const child of await prisma.taskRun.findMany({ where: { parentTaskRunId: b.parent.id } })) {
    if (executions.has(child.id)) continue;
    expect(child.status, `child ${child.id} left non-terminal`).toMatch(
      /^(SYSTEM_FAILURE|COMPLETED_WITH_ERRORS|CANCELED|EXPIRED|CRASHED|TIMED_OUT)$/
    );
  }

  // Every failed run that does not resolve an index is a retired duplicate: it must not alert.
  const resultRuns = new Set([...results.map((r) => r.runId), ...(opts.alertedRunIds ?? [])]);
  const childIds = new Set(runIds);
  expect(
    h.failed
      .filter((e) => childIds.has(e.run.id) && !resultRuns.has(e.run.id) && !e.suppressAlerts)
      .map((e) => e.run.id),
    "a retired child alerted"
  ).toEqual([]);

  expect(positions, "batch position owners while the batch was open").toBe(b.count);
  // The resume snapshot is visible before its block is cleared, so wait for the clear itself.
  await expect
    .poll(() => positionFields(h, b.parent.id), {
      timeout: 20_000,
      interval: 50,
      message: "the resumed parent kept position fields",
    })
    .toEqual([]);
  const indexes = [...edges]
    .map((field) => parseEdgeField(field)?.batchIndex)
    .filter((index) => index !== undefined)
    .sort();
  expect(indexes, "raw parent edges per index").toEqual(
    Array.from({ length: b.count }, (_, i) => i)
  );
  // Finish the parent so the environment's concurrency is free for the next batch.
  const parent = await h.engine.getRunExecutionData({ runId: b.parent.id });
  await h.engine.completeRunAttempt({
    runId: b.parent.id,
    snapshotId: parent!.snapshot.id,
    completion: { id: b.parent.id, ok: true, output: "{}", outputType: "application/json" },
  });
  return { executions };
}
