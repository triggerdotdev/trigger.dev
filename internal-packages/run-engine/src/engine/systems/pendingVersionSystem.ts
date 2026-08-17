import {
  compareDeploymentVersions,
  parseNaturalLanguageDuration,
} from "@trigger.dev/core/v3/isomorphic";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import type { EnqueueSystem } from "./enqueueSystem.js";
import type { SystemResources } from "./systems.js";

import { boundedIn } from "@trigger.dev/database";
export type PendingVersionSystemOptions = {
  resources: SystemResources;
  enqueueSystem: EnqueueSystem;
  queueRunsPendingVersionBatchSize?: number;
  /**
   * How long to wait before retrying when the lookup returned zero
   * candidates. Bounded by {@link lagMaxRetries}. Defaults to 5s.
   *
   * The ClickHouse-backed lookup can miss runs that were just inserted
   * to Postgres due to replication lag. One bounded retry gives the
   * pipeline time to catch up.
   */
  lagRetryDelayMs?: number;
  /**
   * Maximum number of times to reschedule when the lookup returned zero
   * candidates. Defaults to 1 — first attempt + one retry. Set to 0 to
   * disable lag-aware retries entirely.
   */
  lagMaxRetries?: number;
  externalDeploymentParkDeadlineMs?: number;
};

const DEFAULT_LAG_RETRY_DELAY_MS = 5_000;
const DEFAULT_LAG_MAX_RETRIES = 1;
const DEFAULT_EXTERNAL_DEPLOYMENT_PARK_DEADLINE_MS = 60 * 60 * 1000;

export const PARKED_ON_EXTERNAL_DEPLOYMENT_STATUS_REASON = "EXTERNAL_DEPLOYMENT_PENDING";

const EXPIRED_ON_EXTERNAL_DEPLOYMENT_STATUS_REASON = "EXTERNAL_DEPLOYMENT_NOT_FOUND";

const MAX_DEPLOYMENT_CANDIDATES = 20;

type ExternalDeploymentWorker = {
  id: string;
  version: string;
  sdkVersion?: string;
  cliVersion?: string;
};

function readExternalDeploymentIdAnnotation(annotations: unknown): string | undefined {
  if (typeof annotations !== "object" || annotations === null) {
    return undefined;
  }

  const value = (annotations as Record<string, unknown>).externalDeploymentId;

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class PendingVersionSystem {
  private readonly $: SystemResources;
  private readonly enqueueSystem: EnqueueSystem;

  constructor(private readonly options: PendingVersionSystemOptions) {
    this.$ = options.resources;
    this.enqueueSystem = options.enqueueSystem;
  }

  async enqueueRunsForBackgroundWorker(backgroundWorkerId: string, attempt: number = 0) {
    //It could be a lot of runs, so we will process them in a batch
    //if there are still more to process we will enqueue this function again
    const maxCount = this.options.queueRunsPendingVersionBatchSize ?? 200;

    const backgroundWorker = await this.$.prisma.backgroundWorker.findFirst({
      where: {
        id: backgroundWorkerId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
        tasks: true,
        queues: true,
        deployment: {
          select: { externalId: true },
        },
      },
    });

    if (!backgroundWorker) {
      this.$.logger.error("#enqueueRunsForBackgroundWorker: background worker not found", {
        id: backgroundWorkerId,
      });
      return;
    }

    const taskIdentifiers = backgroundWorker.tasks.map((task) => task.slug);
    const queues = backgroundWorker.queues.map((queue) => queue.name);
    const externalDeploymentId = backgroundWorker.deployment?.externalId ?? undefined;

    this.$.logger.debug("Finding PENDING_VERSION runs for background worker", {
      workerId: backgroundWorker.id,
      taskIdentifiers,
      queues,
      externalDeploymentId,
    });

    // Step 1: ask the injected lookup (typically ClickHouse-backed) for
    // candidate run ids. Best-effort — results may be stale or incomplete.
    const { runIds: candidateIds } =
      await this.$.pendingVersionRunIdLookup.lookupPendingVersionRunIds({
        organizationId: backgroundWorker.runtimeEnvironment.organizationId,
        projectId: backgroundWorker.projectId,
        environmentId: backgroundWorker.runtimeEnvironmentId,
        taskIdentifiers,
        queues,
        externalDeploymentId,
        limit: maxCount + 1,
      });

    if (!candidateIds.length) {
      await this.#maybeScheduleLagRetry(backgroundWorkerId, attempt, "lookup_empty");
      return;
    }

    // Step 2: fetch the actual rows from the primary by id, filtered by
    // `status: "PENDING_VERSION"` so any candidate whose status has moved
    // is dropped. The planner uses the PK for `id IN (…)`; the status
    // predicate is a residual filter and does NOT require the status
    // index.
    const pendingRuns = await this.$.runStore.findRuns(
      {
        where: {
          id: { in: boundedIn(candidateIds) },
          status: "PENDING_VERSION",
        },
        orderBy: {
          createdAt: "asc",
        },
      },
      this.$.prisma
    );

    if (!pendingRuns.length) {
      // CH returned candidates but all of them have already moved past
      // PENDING_VERSION (typically because a concurrent deploy or retry
      // beat us to them). Don't reschedule — there's no work to wait for.
      await this.#maybeScheduleExternalDeploymentLagRetry(
        backgroundWorkerId,
        attempt,
        externalDeploymentId
      );
      return;
    }

    this.$.logger.debug("Enqueueing PENDING_VERSION runs for background worker", {
      workerId: backgroundWorker.id,
      lookupName: this.$.pendingVersionRunIdLookup.name,
      candidateCount: candidateIds.length,
      pendingRunCount: pendingRuns.length,
      externalDeploymentId,
      runs: pendingRuns.map((run) => ({
        id: run.id,
        taskIdentifier: run.taskIdentifier,
        queue: run.queue,
        createdAt: run.createdAt,
        priorityMs: run.priorityMs,
      })),
    });

    const now = new Date();
    let promotedCount = 0;
    let skippedForOtherId = 0;

    const externalDeploymentPin = externalDeploymentId
      ? ((await this.#findDeployedWorkerForExternalId(
          backgroundWorker.runtimeEnvironmentId,
          externalDeploymentId
        )) ?? {
          id: backgroundWorker.id,
          version: backgroundWorker.version,
          sdkVersion: backgroundWorker.sdkVersion ?? undefined,
          cliVersion: backgroundWorker.cliVersion ?? undefined,
        })
      : undefined;

    for (const run of pendingRuns) {
      const runExternalDeploymentId =
        run.statusReason === PARKED_ON_EXTERNAL_DEPLOYMENT_STATUS_REASON
          ? readExternalDeploymentIdAnnotation(run.annotations)
          : undefined;

      if (runExternalDeploymentId && runExternalDeploymentId !== externalDeploymentId) {
        skippedForOtherId++;
        continue;
      }

      const pin =
        runExternalDeploymentId && externalDeploymentPin
          ? {
              lockedToVersionId: externalDeploymentPin.id,
              taskVersion: externalDeploymentPin.version,
              sdkVersion: externalDeploymentPin.sdkVersion ?? undefined,
              cliVersion: externalDeploymentPin.cliVersion ?? undefined,
            }
          : {};

      const stillDelayed = run.delayUntil !== null && run.delayUntil > now;

      // Atomic unit: the status promotion and the new QUEUED snapshot must commit together
      // or a crash between them leaves the run promoted-to-PENDING with no snapshot. Under the run-ops
      // split these route to the run's owning DB but, as two router calls, would each auto-commit.
      // `runInTransaction` shares ONE owning-DB transaction; the inner writes use the tx-bound `store`
      // (promotePendingVersionRuns directly, the snapshot via enqueueRun's `store` passthrough). The
      // Redis enqueue inside enqueueRun is NOT in this transaction (Redis never was — unchanged).
      const promoted = await this.$.runStore.runInTransaction(run.id, async (store, tx) => {
        // Idempotency guard: only flips PENDING_VERSION → PENDING. If another
        // worker already promoted this run between our findMany and the
        // update, count is 0 and we skip the enqueue.
        const updateResult = await store.promotePendingVersionRuns(
          run.id,
          { ...pin, status: stillDelayed ? "DELAYED" : "PENDING" },
          tx
        );

        if (updateResult.count === 0) {
          return false;
        }

        if (stillDelayed) {
          return true;
        }

        const updatedRun = await store.findRunOrThrow({ id: run.id }, tx);

        await this.enqueueSystem.enqueueRun({
          run: updatedRun,
          env: backgroundWorker.runtimeEnvironment,
          store,
          tx,
          // PENDING_VERSION re-enqueue is the first time this run is actually
          // entering the run queue (the original enqueue was held back waiting
          // for a worker version). Arm TTL here so the TTL system can expire it
          // if it sits queued waiting on a concurrency slot.
          includeTtl: true,
        });

        return true;
      });

      if (!promoted) continue;

      promotedCount++;

      if (stillDelayed && run.delayUntil) {
        await this.$.worker.enqueue({
          id: `enqueueDelayedRun:${run.id}`,
          job: "enqueueDelayedRun",
          payload: { runId: run.id },
          availableAt: run.delayUntil,
        });
      }

      this.$.eventBus.emit("runStatusChanged", {
        time: new Date(),
        run: {
          id: run.id,
          status: stillDelayed ? "DELAYED" : "PENDING",
          updatedAt: run.updatedAt,
          createdAt: run.createdAt,
          runTags: run.runTags,
          batchId: run.batchId,
        },
        organization: {
          id: backgroundWorker.runtimeEnvironment.organizationId,
        },
        project: {
          id: backgroundWorker.runtimeEnvironment.projectId,
        },
        environment: {
          id: backgroundWorker.runtimeEnvironmentId,
        },
      });
    }

    if (candidateIds.length > maxCount && (promotedCount > 0 || skippedForOtherId === 0)) {
      await this.scheduleResolvePendingVersionRuns(backgroundWorkerId);
      return;
    }

    await this.#maybeScheduleExternalDeploymentLagRetry(
      backgroundWorkerId,
      attempt,
      externalDeploymentId
    );
  }

  // A run parked on an external deployment id is typically created moments before the
  // deployment finalizes, so replication lag can hide it from the candidate lookup. The
  // `lookup_empty` retry does not cover that: any other visible parked run in the
  // environment makes the lookup non-empty and suppresses it. Arm one bounded follow-up
  // whenever the landing deployment carries an id, so a just-parked run is picked up in
  // seconds instead of waiting for the park deadline.
  async #maybeScheduleExternalDeploymentLagRetry(
    backgroundWorkerId: string,
    attempt: number,
    externalDeploymentId: string | undefined
  ): Promise<void> {
    if (!externalDeploymentId) {
      return;
    }

    await this.#maybeScheduleLagRetry(
      backgroundWorkerId,
      attempt,
      "external_deployment_replication_lag"
    );
  }

  async scheduleResolvePendingVersionRuns(
    backgroundWorkerId: string,
    opts?: { attempt?: number; availableAt?: Date }
  ): Promise<void> {
    //we want this to happen in the background
    await this.$.worker.enqueue({
      job: "queueRunsPendingVersion",
      payload: { backgroundWorkerId, attempt: opts?.attempt },
      availableAt: opts?.availableAt,
    });
  }

  async scheduleExternalDeploymentParkDeadline({
    runId,
    externalDeploymentId,
    ttl,
    delayUntil,
  }: {
    runId: string;
    externalDeploymentId: string;
    ttl?: string | null;
    delayUntil?: Date | null;
  }): Promise<void> {
    const deadlineMs =
      this.options.externalDeploymentParkDeadlineMs ?? DEFAULT_EXTERNAL_DEPLOYMENT_PARK_DEADLINE_MS;

    const now = Date.now();
    const anchor = delayUntil && delayUntil.getTime() > now ? delayUntil.getTime() : now;

    const defaultDeadline = new Date(anchor + deadlineMs);
    const ttlDeadline = ttl ? parseNaturalLanguageDuration(ttl) : undefined;

    const availableAt =
      ttlDeadline && ttlDeadline < defaultDeadline ? ttlDeadline : defaultDeadline;

    await this.$.worker.enqueue({
      id: `expireParkedExternalDeploymentRun:${runId}`,
      job: "expireParkedExternalDeploymentRun",
      payload: { runId, externalDeploymentId },
      availableAt,
    });
  }

  async expireParkedExternalDeploymentRun({
    runId,
    externalDeploymentId,
  }: {
    runId: string;
    externalDeploymentId: string;
  }): Promise<void> {
    const run = await this.$.runStore.findRun(
      { id: runId },
      {
        select: {
          id: true,
          status: true,
          annotations: true,
          runtimeEnvironmentId: true,
          organizationId: true,
          projectId: true,
          spanId: true,
          ttl: true,
          taskEventStore: true,
          createdAt: true,
          updatedAt: true,
          delayUntil: true,
          runTags: true,
          batchId: true,
          associatedWaitpoint: { select: { id: true } },
        },
      },
      this.$.prisma
    );

    if (!run) {
      this.$.logger.debug("expireParkedExternalDeploymentRun: run not found", { runId });
      return;
    }

    if (!run.organizationId) {
      this.$.logger.error("expireParkedExternalDeploymentRun: run has no organization", { runId });
      return;
    }

    if (run.status !== "PENDING_VERSION") {
      return;
    }

    if (readExternalDeploymentIdAnnotation(run.annotations) !== externalDeploymentId) {
      this.$.logger.debug(
        "expireParkedExternalDeploymentRun: run no longer parked on this external deployment id",
        { runId, externalDeploymentId }
      );
      return;
    }

    const env = await this.$.controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

    if (!env) {
      this.$.logger.error("expireParkedExternalDeploymentRun: environment not found", {
        runId,
        environmentId: run.runtimeEnvironmentId,
      });
      return;
    }

    const worker = await this.#findDeployedWorkerForExternalId(
      run.runtimeEnvironmentId,
      externalDeploymentId
    );

    if (worker) {
      this.$.logger.info(
        "expireParkedExternalDeploymentRun: deployment landed after all, releasing run",
        { runId, externalDeploymentId, workerId: worker.id, version: worker.version }
      );

      const released = await this.#promoteParkedRun({
        run: {
          id: run.id,
          delayUntil: run.delayUntil,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          runTags: run.runTags,
          batchId: run.batchId,
        },
        env,
        pin: worker,
      });

      if (released) {
        return;
      }

      const stillParked = await this.$.runStore.findRun(
        { id: runId },
        { select: { status: true } },
        this.$.prisma
      );

      if (stillParked?.status !== "PENDING_VERSION") {
        return;
      }

      this.$.logger.warn(
        "expireParkedExternalDeploymentRun: deployment holds the id but the run could not be released, expiring",
        { runId, externalDeploymentId, workerId: worker.id }
      );
    }

    const error: TaskRunError = {
      type: "STRING_ERROR",
      raw: `Run expired because no deployment with external id '${externalDeploymentId}' became available`,
    };

    const now = new Date();

    const result = await this.$.runStore.expireParkedRun(
      runId,
      {
        error,
        completedAt: now,
        expiredAt: now,
        statusReason: EXPIRED_ON_EXTERNAL_DEPLOYMENT_STATUS_REASON,
        snapshot: {
          engine: "V2",
          executionStatus: "FINISHED",
          description: `Run was expired because no deployment with external id '${externalDeploymentId}' became available`,
          runStatus: "EXPIRED",
          environmentId: run.runtimeEnvironmentId,
          environmentType: env.type,
          projectId: run.projectId,
          organizationId: run.organizationId,
        },
      },
      this.$.prisma
    );

    if (result.count === 0) {
      return;
    }

    if (run.associatedWaitpoint) {
      await this.$.worker.enqueue({
        id: `finishWaitpoint.externalDeploymentPark.${run.associatedWaitpoint.id}`,
        job: "finishWaitpoint",
        payload: {
          waitpointId: run.associatedWaitpoint.id,
          error: JSON.stringify(error),
        },
      });
    }

    this.$.eventBus.emit("runExpired", {
      time: now,
      run: {
        id: runId,
        status: "EXPIRED",
        spanId: run.spanId,
        ttl: run.ttl,
        taskEventStore: run.taskEventStore,
        createdAt: run.createdAt,
        completedAt: now,
        expiredAt: now,
        updatedAt: now,
      },
      organization: {
        id: run.organizationId,
      },
      project: {
        id: run.projectId,
      },
      environment: {
        id: run.runtimeEnvironmentId,
      },
    });
  }

  async #promoteParkedRun({
    run,
    env,
    pin,
  }: {
    run: {
      id: string;
      delayUntil: Date | null;
      createdAt: Date;
      updatedAt: Date;
      runTags: string[];
      batchId: string | null;
    };
    env: MinimalAuthenticatedEnvironment & { organizationId?: string; projectId?: string };
    pin: ExternalDeploymentWorker;
  }): Promise<boolean> {
    const stillDelayed = run.delayUntil !== null && run.delayUntil > new Date();

    const promoted = await this.$.runStore.runInTransaction(run.id, async (store, tx) => {
      const updateResult = await store.promotePendingVersionRuns(
        run.id,
        {
          status: stillDelayed ? "DELAYED" : "PENDING",
          lockedToVersionId: pin.id,
          taskVersion: pin.version,
          sdkVersion: pin.sdkVersion ?? undefined,
          cliVersion: pin.cliVersion ?? undefined,
        },
        tx
      );

      if (updateResult.count === 0) {
        return false;
      }

      if (stillDelayed) {
        return true;
      }

      const updatedRun = await store.findRunOrThrow({ id: run.id }, tx);

      await this.enqueueSystem.enqueueRun({
        run: updatedRun,
        env,
        store,
        tx,
        includeTtl: true,
      });

      return true;
    });

    if (!promoted) {
      return false;
    }

    if (stillDelayed && run.delayUntil) {
      await this.$.worker.enqueue({
        id: `enqueueDelayedRun:${run.id}`,
        job: "enqueueDelayedRun",
        payload: { runId: run.id },
        availableAt: run.delayUntil,
      });
    }

    this.$.eventBus.emit("runStatusChanged", {
      time: new Date(),
      run: {
        id: run.id,
        status: stillDelayed ? "DELAYED" : "PENDING",
        updatedAt: run.updatedAt,
        createdAt: run.createdAt,
        runTags: run.runTags,
        batchId: run.batchId,
      },
      organization: { id: env.organization.id },
      project: { id: env.project.id },
      environment: { id: env.id },
    });

    return true;
  }

  async #findDeployedWorkerForExternalId(
    environmentId: string,
    externalDeploymentId: string
  ): Promise<ExternalDeploymentWorker | undefined> {
    const candidates = await this.$.prisma.workerDeployment.findMany({
      where: {
        environmentId,
        externalId: externalDeploymentId,
        status: "DEPLOYED",
      },
      select: {
        version: true,
        worker: { select: { id: true, version: true, sdkVersion: true, cliVersion: true } },
      },
      orderBy: { id: "desc" },
      take: MAX_DEPLOYMENT_CANDIDATES,
    });

    let highest: { version: string; worker: ExternalDeploymentWorker } | undefined;

    for (const candidate of candidates) {
      if (!candidate.worker) continue;
      if (highest && compareDeploymentVersions(candidate.version, highest.version) <= 0) continue;
      highest = {
        version: candidate.version,
        worker: {
          id: candidate.worker.id,
          version: candidate.worker.version,
          sdkVersion: candidate.worker.sdkVersion ?? undefined,
          cliVersion: candidate.worker.cliVersion ?? undefined,
        },
      };
    }

    return highest?.worker;
  }

  /**
   * Schedule one more lookup attempt when the first found zero candidates,
   * to cover ClickHouse replication lag against `task_runs_v2`. Bounded by
   * `lagMaxRetries` so we never loop indefinitely.
   */
  async #maybeScheduleLagRetry(
    backgroundWorkerId: string,
    attempt: number,
    reason: "lookup_empty" | "external_deployment_replication_lag"
  ): Promise<void> {
    const maxRetries = this.options.lagMaxRetries ?? DEFAULT_LAG_MAX_RETRIES;

    if (attempt >= maxRetries) {
      return;
    }

    const delayMs = this.options.lagRetryDelayMs ?? DEFAULT_LAG_RETRY_DELAY_MS;

    this.$.logger.debug("Scheduling pending-version lag retry", {
      backgroundWorkerId,
      attempt: attempt + 1,
      maxRetries,
      delayMs,
      reason,
    });

    await this.scheduleResolvePendingVersionRuns(backgroundWorkerId, {
      attempt: attempt + 1,
      availableAt: new Date(Date.now() + delayMs),
    });
  }
}
