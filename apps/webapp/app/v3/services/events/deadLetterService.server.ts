import { type TaskRun } from "@trigger.dev/database";
import { PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../../friendlyIdentifiers";
import { BaseService } from "../baseService.server";

type EventContext = {
  eventId: string;
  eventType: string;
  sourceEventId?: string;
};

export class DeadLetterService extends BaseService {
  /**
   * Check if a failed run was triggered by an event and create a DLQ entry if so.
   * Called from FinalizeTaskRunService when a run reaches a failed status.
   */
  public async handleFailedRun(run: TaskRun, error: unknown): Promise<void> {
    const eventContext = this.extractEventContext(run);
    if (!eventContext) {
      return; // Not an event-triggered run
    }

    // Check if DLQ is disabled for this event type
    const dlqEnabled = await this.isDLQEnabled(eventContext.eventType, run.projectId);
    if (!dlqEnabled) {
      logger.debug("DLQ disabled for event type, skipping", {
        runId: run.id,
        eventType: eventContext.eventType,
      });
      return;
    }

    try {
      await this._prisma.deadLetterEvent.create({
        data: {
          id: generateFriendlyId("dle"),
          friendlyId: generateFriendlyId("dle"),
          eventType: eventContext.eventType,
          payload: this.extractPayload(run),
          taskSlug: run.taskIdentifier,
          failedRunId: run.id,
          error: error !== undefined && error !== null ? (error as object) : undefined,
          attemptCount: run.attemptNumber ?? 1,
          sourceEventId: eventContext.sourceEventId ?? eventContext.eventId,
          projectId: run.projectId,
          environmentId: run.runtimeEnvironmentId,
        },
      });

      logger.info("Created dead letter event for failed event-triggered run", {
        runId: run.id,
        eventType: eventContext.eventType,
        eventId: eventContext.eventId,
        taskSlug: run.taskIdentifier,
      });
    } catch (error) {
      logger.error("Failed to create dead letter event", {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async isDLQEnabled(eventType: string, projectId: string): Promise<boolean> {
    try {
      const eventDef = await this._prisma.eventDefinition.findFirst({
        where: { slug: eventType, projectId },
        select: { dlqConfig: true },
      });

      if (!eventDef?.dlqConfig) {
        return true; // Default: DLQ enabled
      }

      const config = eventDef.dlqConfig as Record<string, unknown>;
      return config.enabled !== false;
    } catch {
      return true; // On error, default to enabled
    }
  }

  private extractEventContext(run: TaskRun): EventContext | null {
    if (!run.metadata) return null;

    try {
      const metadata =
        typeof run.metadata === "string" ? JSON.parse(run.metadata) : run.metadata;

      if (metadata && typeof metadata === "object" && "$$event" in metadata) {
        const event = (metadata as Record<string, unknown>).$$event;
        if (event && typeof event === "object" && "eventType" in event) {
          return event as EventContext;
        }
      }
    } catch {
      // Malformed metadata — not an event-triggered run
    }

    return null;
  }

  private extractPayload(run: TaskRun): object {
    try {
      if (typeof run.payload === "string") {
        const parsed: unknown = JSON.parse(run.payload);
        return typeof parsed === "object" && parsed !== null ? (parsed as object) : { raw: parsed };
      }
      return { raw: run.payload };
    } catch {
      return { raw: run.payload };
    }
  }
}
