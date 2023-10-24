import { HttpEndpointMetadata } from "@trigger.dev/core";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";

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

    //what should the scope of secrets be? and the http endpoints?
    //todo will a user just enter the URL and secret once for all environments?
    const secretKey = `httpendpoint:${endpoint.projectId}:${httpEndpointMetadata.id}`;

    //todo association between EventRecord and httpEndpoint
    //todo wildcards at the end of the URLs, just one triggerHttpEndpoint

    return await $transaction(this.#prismaClient, async (tx) => {
      const existingHttpEndpoint = await tx.triggerHttpEndpoint.findUnique({
        where: {
          key_environmentId: {
            key: httpEndpointMetadata.id,
            environmentId: endpoint.environmentId,
          },
        },
      });

      const httpEndpoint = await tx.triggerHttpEndpoint.upsert({
        where: {
          key_environmentId: {
            key: httpEndpointMetadata.id,
            environmentId: endpoint.environmentId,
          },
        },
        create: {
          key: httpEndpointMetadata.id,
          active: true,
          immediateResponseFilter: httpEndpointMetadata.immediateResponseFilter,
          title: httpEndpointMetadata.title,
          icon: httpEndpointMetadata.icon,
          properties: httpEndpointMetadata.properties,
          secretReference: {
            connectOrCreate: {
              key: "TRIGGER_API_KEY",
            },
          },
          environment: {
            connect: {
              id: endpoint.environment.id,
            },
          },
          project: { connect: { id: endpoint.projectId } },
        },
        update: {},
      });
    });
  }
}
