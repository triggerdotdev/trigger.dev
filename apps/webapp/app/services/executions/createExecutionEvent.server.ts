import { type PrismaClientOrTransaction, prisma } from "~/db.server";
import { logger } from "../logger.server";

export type CreateExecutionEventInput = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  jobId: string;
  runId: string;
  eventTime: Date;
  eventType: "start" | "finish";
  drift?: number;
  concurrencyLimitGroupId?: string | null;
};

export class CreateExecutionEventService {
  constructor(private prismaClient: PrismaClientOrTransaction = prisma) {}

  public async call(input: CreateExecutionEventInput) {
    await this.prismaClient.$executeRaw`
      INSERT INTO "triggerdotdev_events"."run_executions" (
        "organization_id",
        "project_id",
        "environment_id",
        "job_id",
        "run_id",
        "event_time",
        "event_type",
        "drift_amount_in_ms",
        "concurrency_limit_group_id"
      ) VALUES (
        ${input.organizationId},
        ${input.projectId},
        ${input.environmentId},
        ${input.jobId},
        ${input.runId},
        ${input.eventTime},
        ${input.eventType === "start" ? 1 : -1},
        ${input.drift},
        ${input.concurrencyLimitGroupId}
      )
    `;
  }
}

export async function createExecutionEvent(
  input: CreateExecutionEventInput,
  options?: { prismaClient?: PrismaClientOrTransaction }
) {
  const service = new CreateExecutionEventService(options?.prismaClient);

  try {
    return await service.call(input);
  } catch (error) {
    logger.error("Error creating execution event", { error });
  }
}
