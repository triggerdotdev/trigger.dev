import type { Workflow, WorkflowRun } from ".prisma/client";
import { TriggerMetadataSchema } from "@trigger.dev/common-schemas";
import { getIntegration } from "integration-catalog";
import { JSONSchemaFaker } from "json-schema-faker";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { EventRule } from "~/models/workflow.server";

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
        rules: {
          where: {
            environment: {
              slug: environmentSlug,
            },
          },
        },
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

    const payload = await this.#getPayload(
      workflow,
      workflow.runs[0],
      workflow.rules[0]
    );

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
    lastRun?: WorkflowRun & { event: { payload: any } },
    rule?: EventRule
  ) {
    if (workflow.type === "SCHEDULE") {
      return {
        scheduledTime: new Date(),
        lastRunAt: lastRun?.startedAt ?? undefined,
      };
    }

    if (lastRun) {
      return lastRun.event.payload;
    }

    if (workflow.jsonSchema) {
      // @ts-ignore
      return JSONSchemaFaker.generate(workflow.jsonSchema);
    }

    if (workflow.type === "WEBHOOK") {
      const integration = getIntegration(workflow.service);
      if (!integration) {
        return {};
      }

      const trigger = await TriggerMetadataSchema.safeParseAsync(rule?.trigger);

      if (!trigger.success) {
        return {};
      }

      const example = integration.webhooks?.examples(trigger.data.name);
      return example?.payload ?? {};
    }

    return {};
  }
}
