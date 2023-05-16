import type { EventRecord, JobTrigger } from ".prisma/client";
import type { EventFilter } from "@trigger.dev/internal";
import { EventFilterSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { CreateRunService } from "../runs/createRun.server";
import { ResumeTaskService } from "../runs/resumeTask.server";
import { logger } from "../logger";

export class DeliverEventService {
  #prismaClient: PrismaClient;
  #createRunService = new CreateRunService();
  #resumeTaskService = new ResumeTaskService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const eventRecord = await this.#prismaClient.eventRecord.findUniqueOrThrow({
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

    const possibleEventRules = await this.#prismaClient.jobTrigger.findMany({
      where: {
        environmentId: eventRecord.environmentId,
        event: eventRecord.name,
        source: eventRecord.source,
        enabled: true,
        version: {
          aliases: {
            some: {
              name: "latest",
            },
          },
        },
      },
      include: {
        job: true,
        version: true,
      },
    });

    logger.debug("Found possible event rules", {
      possibleEventRules,
      eventLog: eventRecord,
    });

    const matchingEventRules = possibleEventRules.filter((eventRule) =>
      this.#evaluateEventRule(eventRule, eventRecord)
    );

    if (matchingEventRules.length === 0) {
      logger.debug("No matching event rules", {
        eventLog: eventRecord,
      });

      return;
    }

    logger.debug("Found matching event rules", {
      matchingEventRules,
      eventLog: eventRecord,
    });

    for (const eventRule of matchingEventRules) {
      switch (eventRule.action) {
        case "CREATE_RUN": {
          await this.#createRunService.call({
            eventId: eventRecord.id,
            job: eventRule.job,
            version: eventRule.version,
            environment: eventRecord.environment,
          });

          break;
        }
        case "RESUME_TASK": {
          await this.#resumeTaskService.call(
            eventRule.actionIdentifier,
            eventRecord.payload
          );

          // Now we need to delete this event rule
          await this.#prismaClient.jobTrigger.delete({
            where: {
              id: eventRule.id,
            },
          });

          break;
        }
      }
    }

    await this.#prismaClient.eventRecord.update({
      where: {
        id: eventRecord.id,
      },
      data: {
        deliveredAt: new Date(),
      },
    });
  }

  #evaluateEventRule(trigger: JobTrigger, eventRecord: EventRecord): boolean {
    if (!trigger.payloadFilter && !trigger.contextFilter) {
      return true;
    }

    const payloadFilter = EventFilterSchema.safeParse(
      trigger.payloadFilter ?? {}
    );

    const contextFilter = EventFilterSchema.safeParse(
      trigger.contextFilter ?? {}
    );

    if (!payloadFilter.success || !contextFilter.success) {
      logger.error("Invalid event filter", {
        payloadFilter,
        contextFilter,
      });
      return false;
    }

    const eventMatcher = new EventMatcher(eventRecord);

    return eventMatcher.matches({
      payload: payloadFilter.data,
      context: contextFilter.data,
    });
  }
}

export class EventMatcher {
  event: EventRecord;

  constructor(event: EventRecord) {
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
