import type { Organization, RuntimeEnvironment } from ".prisma/client";
import { $transaction, PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { EndpointApi } from "../endpointApi";
import { workerQueue } from "../worker.server";

export class CreateEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    url,
    name,
  }: {
    environment: AuthenticatedEnvironment;
    url: string;
    name: string;
  }) {
    const client = new EndpointApi(environment.apiKey, url);
    await client.ping();

    return await $transaction(this.#prismaClient, async (tx) => {
      const endpoint = await tx.endpoint.upsert({
        where: {
          environmentId_slug: {
            environmentId: environment.id,
            slug: name,
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
          slug: name,
          url,
        },
        update: {
          url,
        },
      });

      // Kick off process to fetch the jobs for this endpoint
      await workerQueue.enqueue(
        "endpointRegistered",
        {
          id: endpoint.id,
        },
        { tx }
      );

      return endpoint;
    });
  }
}
