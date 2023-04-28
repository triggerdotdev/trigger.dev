import type { EventLog, JobEventRule } from ".prisma/client";
import type { EventFilter } from "@trigger.dev/internal";
import { EventFilterSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { CreateRunService } from "../runs/createRun.server";
import { ResumeTaskService } from "../runs/resumeTask.server";
import { logger } from "../logger";

export class DeliverEventService {
  #prismaClient: PrismaClient;
  #createExecutionService = new CreateRunService();
  #resumeTaskService = new ResumeTaskService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const eventLog = await this.#prismaClient.eventLog.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        environment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    const possibleEventRules = await this.#prismaClient.jobEventRule.findMany({
      where: {
        environmentId: eventLog.environmentId,
        event: eventLog.name,
        source: eventLog.source,
        enabled: true,
        jobInstance: {
          aliases: {
            some: {
              name: "latest",
            },
          },
        },
      },
      include: {
        job: true,
        jobInstance: true,
      },
    });

    logger.debug("Found possible event rules", {
      possibleEventRules,
      eventLog,
    });

    const matchingEventRules = possibleEventRules.filter((eventRule) =>
      this.#evaluateEventRule(eventRule, eventLog)
    );

    if (matchingEventRules.length === 0) {
      logger.debug("No matching event rules", {
        eventLog,
      });

      return;
    }

    logger.debug("Found matching event rules", {
      matchingEventRules,
      eventLog,
    });

    for (const eventRule of matchingEventRules) {
      switch (eventRule.action) {
        case "CREATE_EXECUTION": {
          await this.#createExecutionService.call({
            eventId: eventLog.id,
            job: eventRule.job,
            jobInstance: eventRule.jobInstance,
            environment: eventLog.environment,
          });

          break;
        }
        case "RESUME_TASK": {
          await this.#resumeTaskService.call(
            eventRule.actionIdentifier,
            eventLog.payload
          );

          // Now we need to delete this event rule
          await this.#prismaClient.jobEventRule.delete({
            where: {
              id: eventRule.id,
            },
          });

          break;
        }
      }
    }

    await this.#prismaClient.eventLog.update({
      where: {
        id: eventLog.id,
      },
      data: {
        deliveredAt: new Date(),
      },
    });
  }

  #evaluateEventRule(eventRule: JobEventRule, eventLog: EventLog): boolean {
    if (!eventRule.payloadFilter && !eventRule.contextFilter) {
      return true;
    }

    const payloadFilter = EventFilterSchema.safeParse(
      eventRule.payloadFilter ?? {}
    );

    const contextFilter = EventFilterSchema.safeParse(
      eventRule.contextFilter ?? {}
    );

    if (!payloadFilter.success || !contextFilter.success) {
      logger.error("Invalid event filter", {
        payloadFilter,
        contextFilter,
      });
      return false;
    }

    const eventMatcher = new EventMatcher(eventLog);

    return eventMatcher.matches({
      payload: payloadFilter.data,
      context: contextFilter.data,
    });
  }
}

export class EventMatcher {
  event: EventLog;

  constructor(event: EventLog) {
    this.event = event;
  }

  public matches(filter: EventFilter) {
    return patternMatches(this.event, filter);
  }
}

function patternMatches(payload: any, pattern: any): boolean {
  for (const [patternKey, patternValue] of Object.entries(pattern)) {
    const payloadValue = payload[patternKey];

    if (Array.isArray(patternValue)) {
      if (patternValue.length > 0 && !patternValue.includes(payloadValue)) {
        return false;
      }
    } else if (typeof patternValue === "object") {
      if (Array.isArray(payloadValue)) {
        if (!payloadValue.some((item) => patternMatches(item, patternValue))) {
          return false;
        }
      } else {
        if (!patternMatches(payloadValue, patternValue)) {
          return false;
        }
      }
    }
  }
  return true;
}
