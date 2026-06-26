import { EnqueueSystem } from "./enqueueSystem.js";
import { SystemResources } from "./systems.js";

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
};

const DEFAULT_LAG_RETRY_DELAY_MS = 5_000;
const DEFAULT_LAG_MAX_RETRIES = 1;

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

    this.$.logger.debug("Finding PENDING_VERSION runs for background worker", {
      workerId: backgroundWorker.id,
      taskIdentifiers,
      queues,
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
          id: { in: candidateIds },
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
      return;
    }

    this.$.logger.debug("Enqueueing PENDING_VERSION runs for background worker", {
      workerId: backgroundWorker.id,
      lookupName: this.$.pendingVersionRunIdLookup.name,
      candidateCount: candidateIds.length,
      pendingRunCount: pendingRuns.length,
      runs: pendingRuns.map((run) => ({
        id: run.id,
        taskIdentifier: run.taskIdentifier,
        queue: run.queue,
        createdAt: run.createdAt,
        priorityMs: run.priorityMs,
      })),
    });

    for (const run of pendingRuns) {
      const promoted = await this.$.prisma.$transaction(async (tx) => {
        // Idempotency guard: only flips PENDING_VERSION → PENDING. If another
        // worker already promoted this run between our findMany and the
        // update, count is 0 and we skip the enqueue.
        const updateResult = await this.$.runStore.promotePendingVersionRuns(run.id, tx);

        if (updateResult.count === 0) {
          return false;
        }

        const updatedRun = await this.$.runStore.findRunOrThrow({ id: run.id }, tx);

        await this.enqueueSystem.enqueueRun({
          run: updatedRun,
          env: backgroundWorker.runtimeEnvironment,
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

      this.$.eventBus.emit("runStatusChanged", {
        time: new Date(),
        run: {
          id: run.id,
          status: "PENDING",
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

    // Reschedule when the lookup returned a full-plus-one batch — that's
    // the signal there are more candidates to drain. Use `candidateIds`
    // (the raw lookup result) rather than `pendingRuns` (post-status-guard)
    // because runs that already left PENDING_VERSION shouldn't suppress
    // the next batch.
    if (candidateIds.length > maxCount) {
      await this.scheduleResolvePendingVersionRuns(backgroundWorkerId);
    }
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

  /**
   * Schedule one more lookup attempt when the first found zero candidates,
   * to cover ClickHouse replication lag against `task_runs_v2`. Bounded by
   * `lagMaxRetries` so we never loop indefinitely.
   */
  async #maybeScheduleLagRetry(
    backgroundWorkerId: string,
    attempt: number,
    reason: "lookup_empty"
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
