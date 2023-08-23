import type { Endpoint } from "@trigger.dev/database";
import type { SourceMetadataV2 } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { workerQueue } from "../worker.server";
import { generateSecret } from "./utils.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";

export class RegisterSourceServiceV2 {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    metadata: SourceMetadataV2,
    dynamicTriggerId?: string,
    accountId?: string,
    dynamicSource?: { id: string; metadata: any }
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return this.#upsertSource(
      endpoint,
      endpoint.environment,
      metadata,
      dynamicTriggerId,
      accountId,
      dynamicSource
    );
  }

  async #upsertSource(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    metadata: SourceMetadataV2,
    dynamicTriggerId?: string,
    accountId?: string,
    dynamicSource?: { id: string; metadata: any }
  ) {
    const key = [dynamicTriggerId, dynamicSource?.id, metadata.key].filter(Boolean).join(":");

    const registrationJob = metadata.registerSourceJob
      ? await this.#prismaClient.job.findUnique({
          where: {
            projectId_slug: {
              projectId: endpoint.projectId,
              slug: metadata.registerSourceJob.id,
            },
          },
        })
      : undefined;

    const source = await $transaction(
      this.#prismaClient,
      async (tx) => {
        const integration = await this.#findOrCreateIntegration(
          tx,
          environment.organizationId,
          metadata.integration
        );

        if (!integration) {
          throw new Error("Integration not found");
        }

        const externalAccount = accountId
          ? await tx.externalAccount.findUniqueOrThrow({
              where: {
                environmentId_identifier: {
                  environmentId: environment.id,
                  identifier: accountId,
                },
              },
            })
          : undefined;

        const triggerSource = await tx.triggerSource.upsert({
          where: {
            key_environmentId: {
              environmentId: environment.id,
              key,
            },
          },
          create: {
            version: "2",
            params: metadata.params,
            key,
            channel: metadata.channel,
            organization: {
              connect: {
                id: environment.organizationId,
              },
            },
            endpoint: {
              connect: {
                id: endpoint.id,
              },
            },
            project: {
              connect: {
                id: environment.projectId,
              },
            },
            environment: {
              connect: {
                id: environment.id,
              },
            },
            integration: { connect: { id: integration.id } },
            dynamicTrigger: dynamicTriggerId
              ? {
                  connect: {
                    id: dynamicTriggerId,
                  },
                }
              : undefined,
            externalAccount: externalAccount ? { connect: { id: externalAccount.id } } : undefined,
            options: {
              create: Object.entries(metadata.options).flatMap(([name, values]) =>
                values.map((value) => ({ name, value }))
              ),
            },
            secretReference: {
              connectOrCreate: {
                where: {
                  key: `${endpoint.id}:${key}`,
                },
                create: {
                  key: `${endpoint.id}:${key}`,
                  provider: "DATABASE",
                },
              },
            },
            dynamicSourceId: dynamicSource?.id,
            dynamicSourceMetadata: dynamicSource?.metadata,
            sourceRegistrationJob:
              registrationJob && metadata.registerSourceJob
                ? {
                    connect: {
                      jobId_version_environmentId: {
                        jobId: registrationJob.id,
                        version: metadata.registerSourceJob.version,
                        environmentId: endpoint.environmentId,
                      },
                    },
                  }
                : undefined,
          },
          update: {
            endpoint: {
              connect: {
                id: endpoint.id,
              },
            },
            integration: { connect: { id: integration.id } },
            dynamicSourceId: dynamicSource?.id,
            dynamicSourceMetadata: dynamicSource?.metadata,
            sourceRegistrationJob:
              registrationJob && metadata.registerSourceJob
                ? {
                    connect: {
                      jobId_version_environmentId: {
                        jobId: registrationJob.id,
                        version: metadata.registerSourceJob.version,
                        environmentId: endpoint.environmentId,
                      },
                    },
                  }
                : undefined,
          },
          include: {
            options: true,
            secretReference: true,
          },
        });

        switch (metadata.channel) {
          case "HTTP": {
            await tx.secretStore.upsert({
              where: {
                key: triggerSource.secretReference.key,
              },
              create: {
                key: triggerSource.secretReference.key,
                value: {
                  secret: generateSecret(),
                },
              },
              update: {},
            });
          }
        }

        // Collect the options that are no longer being used so we can remove them
        const newOptions = metadata.options;
        const orphanedOptions: Record<string, string[]> = {};
        for (const event of triggerSource.options) {
          const values = newOptions[event.name];
          if (values === undefined) {
            orphanedOptions[event.name] = [event.value];
            continue;
          }

          if (values!.includes(event.value)) {
            orphanedOptions[event.name] = [...values, event.value];
          }
        }

        //add or update the options
        const flatOptions = Object.entries(newOptions).flatMap(([name, values]) =>
          values.map((v) => ({ name, value: v }))
        );
        for (const { name, value } of flatOptions) {
          await tx.triggerSourceOption.upsert({
            where: {
              name_value_sourceId: {
                name,
                value,
                sourceId: triggerSource.id,
              },
            },
            create: {
              name,
              value,
              source: {
                connect: {
                  id: triggerSource.id,
                },
              },
            },
            update: {},
          });
        }

        return {
          id: triggerSource.id,
          orphanedOptions,
        };
      },
      { timeout: 15000 }
    );

    if (!source) {
      return;
    }

    const { id, orphanedOptions } = source;

    // We need to activate the source if:
    // 1. It's not active
    // 2. There are orphaned events
    // 3. There are trigger events that are not registered
    const triggerSource = await this.#prismaClient.triggerSource.findUniqueOrThrow({
      where: {
        id: id,
      },
      include: {
        options: true,
        secretReference: true,
        integration: true,
      },
    });

    if (dynamicTriggerId) {
      return triggerSource;
    }

    const triggerIsActive = triggerSource.active;
    const triggerHasOrphanedEvents = Object.keys(orphanedOptions).length > 0;
    const triggerHasUnregisteredEvents = triggerSource.options.some((option) => !option.registered);

    if (!triggerIsActive || triggerHasOrphanedEvents || triggerHasUnregisteredEvents) {
      // We need to re-activate the source, and there could be orphaned events
      await workerQueue.enqueue("activateSource", {
        version: "2",
        id: triggerSource.id,
        orphanedOptions,
      });
    }

    return triggerSource;
  }

  async #findOrCreateIntegration(
    tx: PrismaClientOrTransaction,
    organizationId: string,
    config: SourceMetadataV2["integration"]
  ) {
    if (config.authSource === "HOSTED") {
      return tx.integration.findUnique({
        where: {
          organizationId_slug: {
            organizationId,
            slug: config.id,
          },
        },
      });
    } else {
      return tx.integration.upsert({
        where: {
          organizationId_slug: {
            organizationId,
            slug: config.id,
          },
        },
        create: {
          slug: config.id,
          title: config.metadata.name,
          authSource: "LOCAL",
          connectionType: "DEVELOPER",
          organization: {
            connect: {
              id: organizationId,
            },
          },
          definition: {
            connectOrCreate: {
              where: {
                id: config.metadata.id,
              },
              create: {
                id: config.metadata.id,
                name: config.metadata.name,
                instructions: config.metadata.instructions,
              },
            },
          },
        },
        update: {
          title: config.metadata.name,
          authSource: "LOCAL",
          connectionType: "DEVELOPER",
          definition: {
            connectOrCreate: {
              where: {
                id: config.metadata.id,
              },
              create: {
                id: config.metadata.id,
                name: config.metadata.name,
                instructions: config.metadata.instructions,
              },
            },
          },
        },
      });
    }
  }
}
