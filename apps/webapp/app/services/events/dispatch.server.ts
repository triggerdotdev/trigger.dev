import type { EventRule, TriggerEvent } from ".prisma/client";
import { EventFilterSchema } from "@trigger.dev/common-schemas";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import type { Workflow } from "~/models/workflow.server";
import { internalPubSub } from "../messageBroker.server";

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
      throw new Error("Event not found");
    }

    console.log(
      `Dispatching event ${event.id}, type = ${event.type}, name = ${event.name}, service = ${event.service}, environment = ${event.environmentId}`
    );

    const eventRules = await this.#prismaClient.eventRule.findMany({
      where: {
        organizationId: event.organizationId ?? undefined,
        environmentId: event.environmentId ?? undefined,
        type: event.type,
      },
      include: {
        workflow: true,
        environment: true,
      },
    });

    const matcher = new EventMatcher(event);

    const matchingEventRules = eventRules.filter((eventRule) => {
      return matcher.matches(eventRule);
    });

    console.log(
      `Found ${matchingEventRules.length} matching event rules for event ${event.id}`
    );

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
  #json: any;

  constructor(event: TriggerEvent) {
    this.#json = this.#createEventJsonFromEvent(event);
  }

  public matches(eventRule: EventRule) {
    const filter = this.#parseFilter(eventRule);

    if (!filter.success) {
      return false;
    }

    return patternMatches(this.#json, filter.data);
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
    };
  }
}

function patternMatches(payload: any, pattern: any): boolean {
  for (const [key, value] of Object.entries(pattern)) {
    if (Array.isArray(value)) {
      if (!value.includes(payload[key])) {
        return false;
      }
    } else if (typeof value === "object") {
      if (!patternMatches(payload[key], value)) {
        return false;
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
    });

    console.log(
      `Created workflow run ${workflowRun.id} for event rule ${eventRule.id}`
    );

    await internalPubSub.publish("TRIGGER_WORKFLOW_RUN", {
      id: workflowRun.id,
    });

    return workflowRun;
  }
}
