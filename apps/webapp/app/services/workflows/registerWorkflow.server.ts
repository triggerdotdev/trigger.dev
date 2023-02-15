import * as github from "@trigger.dev/github/internal";
import type { WorkflowMetadata } from "internal-platform";
import { WorkflowMetadataSchema } from "internal-platform";
import crypto from "node:crypto";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import type { Workflow } from "~/models/workflow.server";
import { appEventPublisher, taskQueue } from "../messageBroker.server";

export class RegisterWorkflow {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    slug: string,
    payload: unknown,
    organization: Organization,
    environment: RuntimeEnvironment
  ) {
    const validation = WorkflowMetadataSchema.safeParse(payload);

    if (!validation.success) {
      return {
        status: "validationError" as const,
        errors: validation.error.format(),
      };
    }

    const workflow = await this.#upsertWorkflow(
      slug,
      validation.data,
      organization
    );

    if (workflow.isArchived) {
      return {
        status: "success" as const,
        data: { id: workflow.id },
      };
    }

    if (validation.data.trigger.service !== "trigger") {
      const source = await this.upsertSource(
        validation.data,
        organization,
        workflow,
        environment
      );

      if (source && source.status === "READY") {
        await this.#prismaClient.workflow.update({
          where: {
            id: workflow.id,
          },
          data: {
            status: "READY",
          },
        });
      }
    }

    await this.#upsertEventRule(
      workflow,
      validation.data,
      organization,
      environment
    );

    return {
      status: "success" as const,
      data: { id: workflow.id },
    };
  }

  async #upsertEventRule(
    workflow: Workflow,
    payload: WorkflowMetadata,
    organization: Organization,
    environment: RuntimeEnvironment
  ) {
    return this.#prismaClient.eventRule.upsert({
      where: {
        workflowId_environmentId: {
          workflowId: workflow.id,
          environmentId: environment.id,
        },
      },
      update: {
        filter: "filter" in payload.trigger ? payload.trigger.filter : {},
        trigger: payload.trigger,
      },
      create: {
        workflowId: workflow.id,
        environmentId: environment.id,
        organizationId: organization.id,
        filter: "filter" in payload.trigger ? payload.trigger.filter : {},
        type: payload.trigger.type,
        trigger: payload.trigger,
      },
    });
  }

  async #upsertWorkflow(
    slug: string,
    payload: WorkflowMetadata,
    organization: Organization
  ) {
    const existingWorkflow = await this.#prismaClient.workflow.findUnique({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug,
        },
      },
      select: {
        id: true,
      },
    });

    const workflow = await this.#prismaClient.workflow.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug,
        },
      },
      update: {
        title: payload.name,
        packageJson: payload.package,
        type: payload.trigger.type,
        service: payload.trigger.service,
        eventNames: payload.trigger.name,
        triggerTtlInSeconds: payload.triggerTTL,
        jsonSchema:
          "schema" in payload.trigger
            ? payload.trigger.schema
              ? payload.trigger.schema
              : undefined
            : undefined,
      },
      create: {
        organizationId: organization.id,
        slug,
        title: payload.name,
        packageJson: payload.package,
        type: payload.trigger.type,
        status: payload.trigger.service === "trigger" ? "READY" : "CREATED",
        service: payload.trigger.service,
        eventNames: payload.trigger.name,
        triggerTtlInSeconds: payload.triggerTTL,
        jsonSchema:
          "schema" in payload.trigger
            ? payload.trigger.schema
              ? payload.trigger.schema
              : undefined
            : undefined,
      },
      include: {
        externalSource: true,
      },
    });

    if (!existingWorkflow) {
      await taskQueue.publish("WORKFLOW_CREATED", {
        id: workflow.id,
      });
      await taskQueue.publish("WORKFLOW_CREATED", {
        id: workflow.id,
      });
    }

    return workflow;
  }

  async upsertSource(
    payload: WorkflowMetadata,
    organization: Organization,
    workflow: Workflow,
    environment: RuntimeEnvironment
  ) {
    switch (payload.trigger.type) {
      case "WEBHOOK": {
        const externalSource = await this.#upsertWebhookSource(
          payload,
          organization,
          workflow
        );

        if (!externalSource) {
          return;
        }

        await this.#prismaClient.workflow.update({
          where: {
            id: workflow.id,
          },
          data: {
            externalSourceId: externalSource.id,
          },
        });

        await taskQueue.publish("EXTERNAL_SOURCE_UPSERTED", {
          id: externalSource.id,
        });

        return externalSource;
      }
      case "SCHEDULE": {
        if (!payload.trigger.source) {
          return;
        }

        const schedulerSource = await this.#prismaClient.schedulerSource.upsert(
          {
            where: {
              workflowId_environmentId: {
                workflowId: workflow.id,
                environmentId: environment.id,
              },
            },
            update: {
              schedule: payload.trigger.source,
            },
            create: {
              organizationId: organization.id,
              workflowId: workflow.id,
              environmentId: environment.id,
              schedule: payload.trigger.source,
              status: "CREATED",
            },
          }
        );

        await taskQueue.publish("SCHEDULER_SOURCE_UPSERTED", {
          id: schedulerSource.id,
        });

        return schedulerSource;
      }
      case "SLACK_INTERACTION": {
        if (!payload.trigger.source) {
          return;
        }

        return this.#prismaClient.internalSource.upsert({
          where: {
            workflowId_environmentId: {
              workflowId: workflow.id,
              environmentId: environment.id,
            },
          },
          update: {
            source: payload.trigger.source,
          },
          create: {
            organizationId: organization.id,
            workflowId: workflow.id,
            environmentId: environment.id,
            source: payload.trigger.source,
            status: "READY",
            type: "SLACK",
          },
        });
      }
      default: {
        return;
      }
    }
  }

  async #upsertWebhookSource(
    payload: WorkflowMetadata,
    organization: Organization,
    workflow: Workflow
  ) {
    if (payload.trigger.type !== "WEBHOOK") {
      return;
    }

    if (!payload.trigger.source) {
      return;
    }

    const secret = crypto.randomBytes(16).toString("hex");

    if (payload.trigger.manualRegistration) {
      const externalSource = await this.#prismaClient.externalSource.upsert({
        where: {
          organizationId_key: {
            key: `${workflow.id}-${payload.trigger.service}`,
            organizationId: organization.id,
          },
        },
        update: {
          source: payload.trigger.source,
        },
        create: {
          organizationId: organization.id,
          key: `${workflow.id}-${payload.trigger.service}`,
          type: "WEBHOOK",
          source: payload.trigger.source,
          status: "CREATED",
          service: payload.trigger.service,
          manualRegistration: true,
          secret,
        },
      });

      return externalSource;
    } else {
      const existingConnection = await this.#findLatestExistingConnectionInOrg(
        payload.trigger.service,
        organization
      );

      const externalSource = await this.#prismaClient.externalSource.upsert({
        where: {
          organizationId_key: {
            key: this.#keyForExternalSource(payload),
            organizationId: organization.id,
          },
        },
        update: {
          source: payload.trigger.source,
        },
        create: {
          organizationId: organization.id,
          key: this.#keyForExternalSource(payload),
          type: "WEBHOOK",
          source: payload.trigger.source,
          status: "CREATED",
          connectionId: existingConnection?.id,
          service: payload.trigger.service,
          manualRegistration: false,
          secret,
        },
      });

      if (!externalSource.connectionId && existingConnection) {
        await this.#prismaClient.externalSource.update({
          where: {
            id: externalSource.id,
          },
          data: {
            connectionId: existingConnection.id,
          },
        });
      }

      return externalSource;
    }
  }

  #keyForExternalSource(payload: WorkflowMetadata): string {
    if (payload.trigger.type === "WEBHOOK") {
      switch (payload.trigger.service) {
        case "github": {
          return github.internalIntegration.webhooks!.keyForSource(
            payload.trigger.source
          );
        }
        default: {
          return payload.trigger.service;
        }
      }
    } else {
      return payload.trigger.service;
    }
  }

  async #findLatestExistingConnectionInOrg(
    serviceIdentifier: string,
    organization: Organization
  ) {
    const connection = await this.#prismaClient.aPIConnection.findFirst({
      where: {
        organizationId: organization.id,
        apiIdentifier: serviceIdentifier,
        status: "CONNECTED",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return connection;
  }
}
