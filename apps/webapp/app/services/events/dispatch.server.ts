import type { EventRule, TriggerEvent } from ".prisma/client";
import { EventFilterSchema } from "@trigger.dev/common-schemas";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import type { Workflow } from "~/models/workflow.server";
import { taskQueue } from "../messageBroker.server";
import { generateErrorMessage } from "zod-error";
import { logger } from "../logger";

export class DispatchEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const event = await this.#prismaClient.triggerEvent.findUnique({
      where: {
        id,
      },
    });

    if (!event) {
      throw new Error(`Event not found: ${id}`);
    }

    logger.debug("Dispatching event", {
      event,
    });

    const eventRules = await this.#prismaClient.eventRule.findMany({
      where: {
        organizationId: event.organizationId ?? undefined,
        environmentId: event.environmentId ?? undefined,
        type: event.type,
        enabled: true,
      },
      include: {
        workflow: true,
        environment: true,
      },
    });

    logger.debug("Found event rules to check for event", {
      eventRules,
      event,
    });

    const matcher = new EventMatcher(event);

    const matchingEventRules = eventRules.filter((eventRule) => {
      return matcher.matches(eventRule);
    });

    logger.debug("Found matching event rules for event", {
      eventRules,
      matchingEventRules,
      event,
    });

    const dispatchWorkflowRun = new DispatchWorkflowRun();

    await Promise.all(
      matchingEventRules.map((eventRule) => {
        return dispatchWorkflowRun.call(
          eventRule.workflow,
          eventRule,
          event,
          eventRule.environment
        );
      })
    );

    await this.#prismaClient.triggerEvent.update({
      where: {
        id,
      },
      data: {
        dispatchedAt: new Date(),
        status: "DISPATCHED",
      },
    });
  }
}

class EventMatcher {
  json: any;

  constructor(event: TriggerEvent) {
    this.json = this.#createEventJsonFromEvent(event);
  }

  public matches(eventRule: EventRule) {
    console.log(`Matching against event rule ${eventRule.id}`);

    const filter = this.#parseFilter(eventRule);

    if (!filter.success) {
      console.error(
        `Could not parse filter for event rule ${
          eventRule.id
        }, returning false: ${generateErrorMessage(filter.error.issues)}`
      );

      return false;
    }

    return patternMatches(this.json, filter.data);
  }

  #parseFilter(eventRule: EventRule) {
    const filter = EventFilterSchema.safeParse(eventRule.filter);

    return filter;
  }

  #createEventJsonFromEvent(event: TriggerEvent) {
    return {
      event: event.name,
      service: event.service,
      payload: event.payload,
      context: event.context,
    };
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

export class DispatchWorkflowRun {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    workflow: Workflow,
    eventRule: EventRule,
    event: TriggerEvent,
    environment: RuntimeEnvironment
  ) {
    if (workflow.status === "DISABLED") {
      return true;
    }

    const workflowRun = await this.#prismaClient.workflowRun.create({
      data: {
        workflow: {
          connect: {
            id: workflow.id,
          },
        },
        environment: {
          connect: {
            id: environment.id,
          },
        },
        event: {
          connect: {
            id: event.id,
          },
        },
        eventRule: {
          connect: {
            id: eventRule.id,
          },
        },
        status: "PENDING",
        isTest: event.isTest,
      },
      include: {
        workflow: {
          include: {
            externalSource: true,
          },
        },
      },
    });

    if (
      !workflowRun.isTest &&
      workflowRun.workflow.externalSource &&
      workflowRun.workflow.externalSource.status === "CREATED"
    ) {
      await this.#prismaClient.externalSource.update({
        where: {
          id: workflowRun.workflow.externalSource.id,
        },
        data: {
          status: "READY",
        },
      });

      if (workflowRun.workflow.status === "CREATED") {
        await this.#prismaClient.workflow.update({
          where: {
            id: workflowRun.workflow.id,
          },
          data: {
            status: "READY",
          },
        });
      }
    }

    console.log(
      `Created workflow run ${workflowRun.id} for event rule ${eventRule.id}`
    );

    await taskQueue.publish("TRIGGER_WORKFLOW_RUN", {
      id: workflowRun.id,
    });
    await taskQueue.publish("WORKFLOW_RUN_CREATED", {
      id: workflowRun.id,
    });

    return workflowRun;
  }
}
