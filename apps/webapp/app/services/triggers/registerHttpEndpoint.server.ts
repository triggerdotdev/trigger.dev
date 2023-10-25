import { HttpEndpointMetadata } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import { generateSecret } from "../sources/utils.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { z } from "zod";

export class RegisterHttpEndpointService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    httpEndpointMetadata: HttpEndpointMetadata
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    const secretKey = `httpendpoint:${endpoint.projectId}:${httpEndpointMetadata.id}`;

    //todo association between EventRecord and httpEndpoint
    return await $transaction(this.#prismaClient, async (tx) => {
      //upsert the TriggerHttpEndpoint and TriggerHttpEndpointEnvironment
      const httpEndpoint = await tx.triggerHttpEndpoint.upsert({
        where: {
          key_projectId: {
            key: httpEndpointMetadata.id,
            projectId: endpoint.projectId,
          },
        },
        create: {
          key: httpEndpointMetadata.id,
          title: httpEndpointMetadata.title,
          icon: httpEndpointMetadata.icon,
          properties: httpEndpointMetadata.properties,
          secretReference: {
            connectOrCreate: {
              where: {
                key: secretKey,
              },
              create: {
                key: secretKey,
                provider: "DATABASE" as const,
              },
            },
          },
          httpEndpointEnvironments: {
            connectOrCreate: {
              where: {
                environmentId_httpEndpointId: {
                  environmentId: endpoint.environment.id,
                  //todo this is wrong
                  httpEndpointId: httpEndpointMetadata.id,
                },
              },
              create: {
                active: httpEndpointMetadata.enabled,
                immediateResponseFilter: httpEndpointMetadata.immediateResponseFilter,
                environmentId: endpoint.environment.id,
              },
            },
          },
          project: {
            connect: {
              id: endpoint.projectId,
            },
          },
        },
        update: {
          title: httpEndpointMetadata.title,
          icon: httpEndpointMetadata.icon,
          properties: httpEndpointMetadata.properties,
          httpEndpointEnvironments: {
            update: {
              where: {
                environmentId_httpEndpointId: {
                  environmentId: endpoint.environment.id,
                  //todo this is wrong
                  httpEndpointId: httpEndpointMetadata.id,
                },
              },
              data: {
                active: httpEndpointMetadata.enabled,
                immediateResponseFilter: httpEndpointMetadata.immediateResponseFilter,
                environmentId: endpoint.environment.id,
              },
            },
          },
        },
        include: {
          secretReference: true,
        },
      });

      //create/update the secret
      //we don't upsert because we don't want to change an existing one
      const secretStore = getSecretStore(httpEndpoint.secretReference.provider);
      const existingSecret = await secretStore.getSecret(z.string(), secretKey);
      if (!existingSecret) {
        await secretStore.setSecret<{ secret: string }>(secretKey, {
          secret: generateSecret(),
        });
      }
    });
  }
}
