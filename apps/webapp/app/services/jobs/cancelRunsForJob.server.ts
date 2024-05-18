import { $transaction, PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { CancelRunService } from "../runs/cancelRun.server";
import { logger } from "../logger.server";
import { CancelRunsForJob } from "@trigger.dev/core";

export const JobRunStatus = {
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  WAITING_ON_CONNECTIONS: 'WAITING_ON_CONNECTIONS',
  PREPROCESSING: 'PREPROCESSING',
  STARTED: 'STARTED',
  EXECUTING: 'EXECUTING',
  WAITING_TO_CONTINUE: 'WAITING_TO_CONTINUE',
  WAITING_TO_EXECUTE: 'WAITING_TO_EXECUTE',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  TIMED_OUT: 'TIMED_OUT',
  ABORTED: 'ABORTED',
  CANCELED: 'CANCELED',
  UNRESOLVED_AUTH: 'UNRESOLVED_AUTH',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD'
} as const;

const CANCELLABLE_JOB_RUN_STATUS: Array<keyof typeof JobRunStatus> = [
  JobRunStatus.PENDING,
  JobRunStatus.QUEUED,
  JobRunStatus.WAITING_ON_CONNECTIONS,
  JobRunStatus.PREPROCESSING,
  JobRunStatus.STARTED,
  JobRunStatus.EXECUTING,
  JobRunStatus.WAITING_TO_CONTINUE,
  JobRunStatus.WAITING_TO_EXECUTE,
];

export class CancelRunsForJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(environment: AuthenticatedEnvironment, jobSlug: string) {
    return await $transaction<CancelRunsForJob | undefined>(this.#prismaClient, async (tx) => {
      const job = await tx.job.findUnique({
        where: {
          projectId_slug: {
            projectId: environment.projectId,
            slug: jobSlug,
          },
        },
      });

      if (!job) {
        return;
      }

      const jobRuns = await tx.jobRun.findMany({
        where: {
          jobId: job.id,
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
          logger.debug(`failed to cancel job run with id ${jobRun.id} for job ${jobSlug}`);
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
