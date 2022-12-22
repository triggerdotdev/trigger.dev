import { WorkflowMetadataSchema } from "internal-platform";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { internalPubSub } from "~/services/messageBroker.server";
import crypto from "node:crypto";

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

    const workflow = await this.#prismaClient.workflow.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug,
        },
      },
      update: {
        title: validation.data.name,
        packageJson: validation.data.package,
      },
      create: {
        organizationId: organization.id,
        slug,
        title: validation.data.name,
        packageJson: validation.data.package,
      },
      include: {
        triggers: {
          where: {
            environmentId: environment.id,
          },
        },
      },
    });

    const existingTrigger = workflow.triggers[0];

    if (!existingTrigger) {
      const trigger = await this.#prismaClient.workflowTrigger.create({
        data: {
          workflowId: workflow.id,
          environmentId: environment.id,
          type: validation.data.trigger.type,
          config: validation.data.trigger.config,
          status: "CREATED",
          isDefault: environment.slug === "development",
        },
      });

      if (validation.data.trigger.type === "WEBHOOK") {
        const serviceIdentifier = this.#parseServiceIdentifier(
          validation.data.trigger.config.id
        );

        const existingConnection =
          await this.#findLatestExistingConnectionInOrg(
            serviceIdentifier,
            organization
          );

        // Create the connectionSlot and then fire the connectionSlot created event
        const connectionSlot =
          await this.#prismaClient.workflowConnectionSlot.create({
            data: {
              workflowId: workflow.id,
              triggerId: trigger.id,
              serviceIdentifier,
              connectionId: existingConnection?.id,
              slotName: "trigger",
              auth: validation.data.trigger.config.webhook,
            },
          });

        const webhook = await this.#prismaClient.registeredWebhook.create({
          data: {
            connectionSlot: {
              connect: {
                id: connectionSlot.id,
              },
            },
            workflow: {
              connect: {
                id: trigger.workflowId,
              },
            },
            trigger: {
              connect: {
                id: trigger.id,
              },
            },
            secret: crypto.randomBytes(32).toString("hex"),
          },
        });

        await internalPubSub.publish("REGISTERED_WEBHOOK_CREATED", {
          id: webhook.id,
        });
      }

      return {
        status: "success" as const,
        data: {
          id: workflow.id,
        },
      };
    } else {
      if (existingTrigger.type === validation.data.trigger.type) {
        await this.#prismaClient.workflowTrigger.update({
          where: {
            id: existingTrigger.id,
          },
          data: {
            config: validation.data.trigger.config,
          },
        });

        if (validation.data.trigger.type === "WEBHOOK") {
          const serviceIdentifier = this.#parseServiceIdentifier(
            validation.data.trigger.config.id
          );

          const existingConnection =
            await this.#findLatestExistingConnectionInOrg(
              serviceIdentifier,
              organization
            );

          const existingConnectionSlot =
            await this.#prismaClient.workflowConnectionSlot.findFirst({
              where: {
                workflowId: workflow.id,
                triggerId: existingTrigger.id,
                serviceIdentifier,
              },
            });

          if (existingConnectionSlot) {
            await this.#prismaClient.workflowConnectionSlot.update({
              where: {
                id: existingConnectionSlot.id,
              },
              data: {
                connectionId: existingConnectionSlot.connectionId
                  ? existingConnectionSlot.connectionId
                  : existingConnection?.id,
                auth: validation.data.trigger.config.webhook,
              },
            });
          } else {
            // Create the connectionSlot and then fire the connectionSlot created event
            const connectionSlot =
              await this.#prismaClient.workflowConnectionSlot.create({
                data: {
                  workflowId: workflow.id,
                  triggerId: existingTrigger.id,
                  serviceIdentifier,
                  connectionId: existingConnection?.id,
                  slotName: "trigger",
                  auth: validation.data.trigger.config.webhook,
                },
              });

            const webhook = await this.#prismaClient.registeredWebhook.create({
              data: {
                connectionSlot: {
                  connect: {
                    id: connectionSlot.id,
                  },
                },
                workflow: {
                  connect: {
                    id: existingTrigger.workflowId,
                  },
                },
                trigger: {
                  connect: {
                    id: existingTrigger.id,
                  },
                },
                secret: crypto.randomBytes(32).toString("hex"),
              },
            });

            await internalPubSub.publish("REGISTERED_WEBHOOK_CREATED", {
              id: webhook.id,
            });
          }
        }

        return {
          status: "success" as const,
          data: {
            id: workflow.id,
          },
        };
      } else {
        return {
          status: "error" as const,
          error: {
            code: "TRIGGER_TYPE_MISMATCH",
            message: "The trigger type cannot be changed",
          },
        };
      }
    }

    // Create or update the workflow
    //todo triggers are environment specific
    //todo connections are shared between environments
    //todo Workflows have connection slots, which are filled with connections (can be empty)
    //todo Workflow has one trigger (can also have a slot with connection)
    //todo WorkflowRuns belong to a workflow + environment
  }

  #parseServiceIdentifier(id: string): string {
    const [serviceIdentifier] = id.split(".");

    return serviceIdentifier;
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
