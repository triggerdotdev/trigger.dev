import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { type Prisma } from "@trigger.dev/database";
import { type PrismaClientOrTransaction, prisma } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { findCurrentWorkerFromEnvironment } from "../models/workerDeployment.server";
import { engine, type RunEngine } from "../runEngine.server";

type QueueActivityEngine = Pick<
  RunEngine,
  "lengthOfQueues" | "currentConcurrencyOfQueues" | "inFlightCountOfQueues"
>;

/** Why a queue can't be archived right now. */
export type ArchiveBlock =
  | { type: "queue_has_active_runs"; activeRuns: number }
  | { type: "queue_in_current_deployment" }
  | { type: "queue_paused" }
  | { type: "queue_limit_zero" };

export type ArchiveQueueError =
  | ArchiveBlock
  | { type: "queue_not_found" }
  | { type: "queue_changed" }
  | { type: "other"; cause: unknown };

type ArchivableQueue = {
  id: string;
  name: string;
  paused: boolean;
  concurrencyLimit: number | null;
  totalConcurrencyLimit: number | null;
  archivedAt: Date | null;
  updatedAt: Date;
};

/**
 * Archiving only hides a queue in the dashboard. It never touches Redis, limits, paused
 * state or worker links, so runs on the queue behave exactly as before.
 */
export class ArchiveQueueService {
  constructor(
    private readonly prismaClient: PrismaClientOrTransaction = prisma,
    private readonly engineClient: QueueActivityEngine = engine
  ) {}

  /** Read-only pre-check the archive dialog runs before offering to confirm. */
  check(
    environment: AuthenticatedEnvironment,
    friendlyId: string
  ): ResultAsync<ArchiveBlock | undefined, ArchiveQueueError> {
    return this.findQueue(environment, friendlyId).andThen((queue) =>
      this.currentWorkers(environment).andThen((workers) =>
        this.blockFor(environment, queue, workers)
      )
    );
  }

  archive(
    environment: AuthenticatedEnvironment,
    friendlyId: string
  ): ResultAsync<void, ArchiveQueueError> {
    return this.findQueue(environment, friendlyId).andThen((queue) => {
      if (queue.archivedAt) {
        return okAsync(undefined);
      }
      return this.currentWorkers(environment).andThen((workers) =>
        this.blockFor(environment, queue, workers).andThen((block) =>
          block ? errAsync(block) : this.markArchived(queue, workers)
        )
      );
    });
  }

  unarchive(
    environment: AuthenticatedEnvironment,
    friendlyId: string
  ): ResultAsync<void, ArchiveQueueError> {
    return this.findQueue(environment, friendlyId).andThen((queue) =>
      fromPromise(
        this.prismaClient.taskQueue.update({
          where: { id: queue.id },
          data: { archivedAt: null },
        }),
        (cause): ArchiveQueueError => ({ type: "other", cause })
      ).map(() => undefined)
    );
  }

  private findQueue(
    environment: AuthenticatedEnvironment,
    friendlyId: string
  ): ResultAsync<ArchivableQueue, ArchiveQueueError> {
    return fromPromise(
      this.prismaClient.taskQueue.findFirst({
        where: { friendlyId, runtimeEnvironmentId: environment.id, role: "QUEUE" },
        select: {
          id: true,
          name: true,
          paused: true,
          concurrencyLimit: true,
          totalConcurrencyLimit: true,
          archivedAt: true,
          updatedAt: true,
        },
      }),
      (cause): ArchiveQueueError => ({ type: "other", cause })
    ).andThen((queue) => (queue ? okAsync(queue) : errAsync({ type: "queue_not_found" as const })));
  }

  /** The current worker plus any as new or newer (a deploy not yet promoted). No current worker: any. */
  private currentWorkers(
    environment: AuthenticatedEnvironment
  ): ResultAsync<Prisma.BackgroundWorkerWhereInput, ArchiveQueueError> {
    return fromPromise(
      findCurrentWorkerFromEnvironment(environment, this.prismaClient).then(async (current) => {
        if (!current) {
          return {};
        }
        const row = await this.prismaClient.backgroundWorker.findFirst({
          where: { id: current.id },
          select: { createdAt: true },
        });
        return row
          ? { OR: [{ id: current.id }, { createdAt: { gte: row.createdAt } }] }
          : { id: current.id };
      }),
      (cause): ArchiveQueueError => ({ type: "other", cause })
    );
  }

  private blockFor(
    environment: AuthenticatedEnvironment,
    queue: ArchivableQueue,
    currentWorkers: Prisma.BackgroundWorkerWhereInput
  ): ResultAsync<ArchiveBlock | undefined, ArchiveQueueError> {
    if (queue.paused) {
      return okAsync({ type: "queue_paused" as const });
    }
    if (queue.concurrencyLimit === 0 || queue.totalConcurrencyLimit === 0) {
      return okAsync({ type: "queue_limit_zero" as const });
    }
    return fromPromise(
      this.prismaClient.taskQueue.count({
        where: { id: queue.id, workers: { some: currentWorkers } },
      }),
      (cause): ArchiveQueueError => ({ type: "other", cause })
    ).andThen((declared) =>
      declared > 0
        ? okAsync({ type: "queue_in_current_deployment" as const })
        : this.activeRunCount(environment, queue.name).map((activeRuns) =>
            activeRuns > 0 ? { type: "queue_has_active_runs" as const, activeRuns } : undefined
          )
    );
  }

  /** Waiting plus in progress. In-flight includes started runs; running covers keyed runs it may miss. */
  private activeRunCount(
    environment: AuthenticatedEnvironment,
    name: string
  ): ResultAsync<number, ArchiveQueueError> {
    return fromPromise(
      Promise.all([
        this.engineClient.lengthOfQueues(environment, [name]),
        this.engineClient.currentConcurrencyOfQueues(environment, [name]),
        this.engineClient.inFlightCountOfQueues(environment, [name]),
      ]),
      (cause): ArchiveQueueError => ({ type: "other", cause })
    ).map(
      ([queued, running, inFlight]) =>
        (queued[name] ?? 0) + Math.max(running[name] ?? 0, inFlight[name] ?? 0)
    );
  }

  /** Conditional so a pause, limit-0 override or deploy racing this write can't be archived. */
  private markArchived(
    queue: ArchivableQueue,
    currentWorkers: Prisma.BackgroundWorkerWhereInput
  ): ResultAsync<void, ArchiveQueueError> {
    return fromPromise(
      this.prismaClient.taskQueue.updateMany({
        where: {
          id: queue.id,
          updatedAt: queue.updatedAt,
          workers: { none: currentWorkers },
          archivedAt: null,
          paused: false,
          AND: [
            { OR: [{ concurrencyLimit: null }, { concurrencyLimit: { not: 0 } }] },
            { OR: [{ totalConcurrencyLimit: null }, { totalConcurrencyLimit: { not: 0 } }] },
          ],
        },
        data: { archivedAt: new Date() },
      }),
      (cause): ArchiveQueueError => ({ type: "other", cause })
    ).andThen(({ count }) =>
      count === 1 ? okAsync(undefined) : errAsync({ type: "queue_changed" as const })
    );
  }
}

export function archiveQueueErrorMessage(error: ArchiveQueueError): string {
  switch (error.type) {
    case "queue_not_found":
      return "Queue not found";
    case "queue_has_active_runs":
      return error.activeRuns === 1
        ? "This queue has 1 run waiting or in progress. You can archive it once it's finished."
        : `This queue has ${error.activeRuns} runs waiting or in progress. You can archive it once they've finished.`;
    case "queue_in_current_deployment":
      return "The current deployment still uses this queue. You can archive it once a deploy no longer declares it.";
    case "queue_paused":
      return "This queue is paused. Resume it before archiving, so no runs get stuck out of sight.";
    case "queue_limit_zero":
      return "This queue has a concurrency limit of 0. Raise or reset the limit before archiving.";
    case "queue_changed":
      return "The queue changed while archiving. Please try again.";
    case "other":
      return "Failed to update the queue";
  }
}
