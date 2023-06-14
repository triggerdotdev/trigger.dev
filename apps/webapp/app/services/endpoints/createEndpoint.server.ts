import { customAlphabet } from "nanoid";
import { $transaction, prisma, PrismaClient } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { EndpointApi } from "../endpointApi";
import { workerQueue } from "../worker.server";

const indexingHookIdentifier = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvxyz",
  10
);

export class CreateEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    url,
    id,
  }: {
    environment: AuthenticatedEnvironment;
    url: string;
    id: string;
  }) {
    const client = new EndpointApi(environment.apiKey, url, id);

    const pong = await client.ping();

    if (!pong.ok) {
      throw new Error(pong.error);
    }

    return await $transaction(this.#prismaClient, async (tx) => {
      const endpoint = await tx.endpoint.upsert({
        where: {
          environmentId_slug: {
            environmentId: environment.id,
            slug: id,
          },
        },
        create: {
          environment: {
            connect: {
              id: environment.id,
            },
          },
          organization: {
            connect: {
              id: environment.organizationId,
            },
          },
          project: {
            connect: {
              id: environment.projectId,
            },
          },
          slug: id,
          url,
          indexingHookIdentifier: indexingHookIdentifier(),
        },
        update: {
          url,
        },
      });

      // Kick off process to fetch the jobs for this endpoint
      await workerQueue.enqueue(
        "indexEndpoint",
        {
          id: endpoint.id,
          source: "INTERNAL",
        },
        { tx }
      );

      return endpoint;
    });
  }
}
