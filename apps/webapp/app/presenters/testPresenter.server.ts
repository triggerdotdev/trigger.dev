import type { Workflow, WorkflowRun } from ".prisma/client";
import { TriggerMetadataSchema } from "@trigger.dev/common-schemas";
import { JSONSchemaFaker } from "json-schema-faker";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { EventRule, ExternalSource } from "~/models/workflow.server";
import { WebhookExamplesPresenter } from "./webhookExamplePresenter.server";

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
    workflow: Workflow & { externalSource: ExternalSource | null },
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
      // If jsonSchema is just { "$schema": "http://json-schema.org/draft-07/schema#" }, then return an empty object
      if (
        Object.keys(workflow.jsonSchema).length === 1 &&
        // @ts-ignore
        workflow.jsonSchema["$schema"]
      ) {
        return {};
      }
      // @ts-ignore
      return JSONSchemaFaker.generate(workflow.jsonSchema);
    }

    if (workflow.type === "WEBHOOK") {
      const trigger = await TriggerMetadataSchema.safeParseAsync(rule?.trigger);

      if (!trigger.success) {
        return {};
      }

      const examplePresenter = new WebhookExamplesPresenter();
      return examplePresenter.data({
        service: workflow.service,
        name: trigger.data.name,
      });
    }

    if (workflow.type === "INTEGRATION_WEBHOOK") {
      const examples = z
        .array(z.any())
        .safeParse(workflow.externalSource?.examples);
      if (examples.success) {
        return examples.data[0];
      }
    }

    return {};
  }
}
