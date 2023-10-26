import { $transaction, PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { JobRunStatus } from "@trigger.dev/database";
import { CancelRunService } from "../runs/cancelRun.server";
import { logger } from "../logger.server";
import { CancelRunsForEvent } from "@trigger.dev/core";

const CANCELLABLE_JOB_RUN_STATUS: JobRunStatus[] = [
  JobRunStatus.PENDING,
  JobRunStatus.QUEUED,
  JobRunStatus.WAITING_ON_CONNECTIONS,
  JobRunStatus.PREPROCESSING,
  JobRunStatus.STARTED,
];

export class CancelRunsForEventService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(environment: AuthenticatedEnvironment, eventId: string) {
    return await $transaction<CancelRunsForEvent | undefined>(this.#prismaClient, async (tx) => {
      const event = await tx.eventRecord.findUnique({
        where: {
          eventId_environmentId: {
            eventId: eventId,
            environmentId: environment.id,
          },
        },
      });

      if (!event) {
        return;
      }

      const jobRuns = await tx.jobRun.findMany({
        where: {
          eventId: event.id,
          status: {
            in: CANCELLABLE_JOB_RUN_STATUS,
          },
        },
        select: {
          id: true,
        },
      });

      const cancelRunService = new CancelRunService(this.#prismaClient);
      const cancelledRunIds: string[] = [];
      const failedToCancelRunIds: string[] = [];

      for (const jobRun of jobRuns) {
        try {
          await cancelRunService.call({ runId: jobRun.id });
          cancelledRunIds.push(jobRun.id);
        } catch (err) {
          logger.debug(`failed to cancel job run with id ${jobRun.id} for event id ${eventId}`);
          failedToCancelRunIds.push(jobRun.id);
        }
      }

      return {
        cancelledRunIds: cancelledRunIds,
        failedToCancelRunIds: failedToCancelRunIds,
      };
    });
  }
}
