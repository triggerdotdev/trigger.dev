import { PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BaseService, ServiceValidationError } from "../baseService.server";
import { TriggerTaskService } from "../triggerTask.server";
import type { TriggerTaskRequestBody } from "@trigger.dev/core/v3";

export type ListDLQParams = {
  projectId: string;
  environmentId: string;
  eventType?: string;
  status?: "PENDING" | "RETRIED" | "DISCARDED";
  limit?: number;
  cursor?: string;
};

export class DeadLetterManagementService extends BaseService {
  public async list(params: ListDLQParams) {
    const limit = Math.min(params.limit ?? 50, 200);

    const items = await this._prisma.deadLetterEvent.findMany({
      where: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        ...(params.eventType && { eventType: params.eventType }),
        ...(params.status && { status: params.status }),
        ...(params.cursor && { createdAt: { lt: new Date(params.cursor) } }),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    const data = items.slice(0, limit);
    const lastItem = data[data.length - 1];

    return {
      data,
      pagination: {
        cursor: hasMore && lastItem ? lastItem.createdAt.toISOString() : null,
        hasMore,
      },
    };
  }

  public async retry(id: string, environment: AuthenticatedEnvironment) {
    const dle = await this._prisma.deadLetterEvent.findFirst({
      where: {
        id,
        projectId: environment.projectId,
        environmentId: environment.id,
        status: "PENDING",
      },
    });

    if (!dle) {
      throw new ServiceValidationError("Dead letter event not found or already processed", 404);
    }

    // Trigger the task again with the same payload
    const triggerService = new TriggerTaskService();
    const body: TriggerTaskRequestBody = {
      payload: dle.payload,
      options: {
        idempotencyKey: `dlq-retry:${dle.id}`,
      },
    };

    let runId: string | undefined;
    try {
      const result = await triggerService.call(dle.taskSlug, environment, body, {
        idempotencyKey: `dlq-retry:${dle.id}`,
      });
      runId = result?.run.friendlyId;
    } catch (error) {
      logger.error("Failed to retry dead letter event", {
        dleId: dle.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceValidationError("Failed to retry dead letter event", 500);
    }

    // Mark as retried
    await this._prisma.deadLetterEvent.update({
      where: { id },
      data: {
        status: "RETRIED",
        processedAt: new Date(),
      },
    });

    return { id: dle.id, status: "RETRIED" as const, runId };
  }

  public async discard(id: string, environment: AuthenticatedEnvironment) {
    const dle = await this._prisma.deadLetterEvent.findFirst({
      where: {
        id,
        projectId: environment.projectId,
        environmentId: environment.id,
        status: "PENDING",
      },
    });

    if (!dle) {
      throw new ServiceValidationError("Dead letter event not found or already processed", 404);
    }

    await this._prisma.deadLetterEvent.update({
      where: { id },
      data: {
        status: "DISCARDED",
        processedAt: new Date(),
      },
    });

    return { id: dle.id, status: "DISCARDED" as const };
  }

  public async retryAll(params: {
    projectId: string;
    environmentId: string;
    eventType?: string;
    environment: AuthenticatedEnvironment;
  }) {
    const pendingItems = await this._prisma.deadLetterEvent.findMany({
      where: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        status: "PENDING",
        ...(params.eventType && { eventType: params.eventType }),
      },
      take: 1000, // Limit batch size
    });

    let retriedCount = 0;
    let failedCount = 0;

    const triggerService = new TriggerTaskService();

    for (const dle of pendingItems) {
      try {
        const body: TriggerTaskRequestBody = {
          payload: dle.payload,
          options: {
            idempotencyKey: `dlq-retry:${dle.id}`,
          },
        };

        await triggerService.call(dle.taskSlug, params.environment, body, {
          idempotencyKey: `dlq-retry:${dle.id}`,
        });

        await this._prisma.deadLetterEvent.update({
          where: { id: dle.id },
          data: { status: "RETRIED", processedAt: new Date() },
        });

        retriedCount++;
      } catch {
        failedCount++;
      }
    }

    return { retriedCount, failedCount };
  }
}
