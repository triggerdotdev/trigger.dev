import type {
  Organization,
  RuntimeEnvironment,
  Workflow,
} from ".prisma/client";
import { ulid } from "ulid";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { DispatchWorkflowRun } from "../events/dispatch.server";

export class CreateWorkflowTestRun {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call({
    eventName,
    payload,
    workflow,
    environment,
    organization,
  }: {
    eventName: string;
    payload: any;
    workflow: Workflow;
    environment: RuntimeEnvironment;
    organization: Organization;
  }) {
    const eventId = ulid();

    const eventRule = await this.#prismaClient.eventRule.findUnique({
      where: {
        workflowId_environmentId: {
          workflowId: workflow.id,
          environmentId: environment.id,
        },
      },
    });

    if (!eventRule) {
      return;
    }

    const event = await this.#prismaClient.triggerEvent.create({
      data: {
        id: eventId,
        organization: {
          connect: {
            id: organization.id,
          },
        },
        environment: environment
          ? {
              connect: {
                id: environment.id,
              },
            }
          : undefined,
        name: eventName,
        timestamp: new Date().toISOString(),
        payload,
        context: {},
        service: workflow.service,
        type: workflow.type,
        isTest: true,
      },
    });

    const dispatchRunService = new DispatchWorkflowRun(this.#prismaClient);

    const run = await dispatchRunService.call(
      workflow,
      eventRule,
      event,
      environment
    );

    return run;
  }
}
