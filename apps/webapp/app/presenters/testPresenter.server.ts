import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { JSONSchemaFaker } from "json-schema-faker";
import type { Workflow, WorkflowRun } from ".prisma/client";

export class WorkflowTestPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data({
    organizationSlug,
    workflowSlug,
    environmentSlug,
  }: {
    organizationSlug: string;
    workflowSlug: string;
    environmentSlug: string;
  }) {
    const workflow = await this.#prismaClient.workflow.findFirst({
      where: {
        slug: workflowSlug,
        organization: {
          slug: organizationSlug,
        },
      },
      include: {
        runs: {
          where: {
            environment: {
              slug: environmentSlug,
            },
          },
          include: {
            event: true,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
        externalSource: true,
      },
    });

    if (!workflow) {
      throw new Error("Workflow not found");
    }

    const payload = await this.#getPayload(workflow, workflow.runs[0]);

    const status =
      workflow.status === "CREATED"
        ? workflow.type === "WEBHOOK" &&
          workflow.externalSource?.manualRegistration
          ? "TESTABLE"
          : "CREATED"
        : workflow.status;

    return { payload, status };
  }

  async #getPayload(
    workflow: Workflow,
    lastRun?: WorkflowRun & { event: { payload: any } }
  ) {
    if (workflow.type === "SCHEDULE") {
      return {
        scheduledTime: new Date(),
        lastRunAt: lastRun?.startedAt,
      };
    }

    if (lastRun) {
      return lastRun.event.payload;
    }

    if (workflow.jsonSchema) {
      // @ts-ignore
      return JSONSchemaFaker.generate(workflow.jsonSchema);
    }

    return {};
  }
}
