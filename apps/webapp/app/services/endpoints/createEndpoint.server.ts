import type { Organization, RuntimeEnvironment } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { ClientApi } from "../clientApi.server";
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
    const client = new ClientApi(environment.apiKey, url);
    await client.ping();

    const endpoint = await this.#prismaClient.endpoint.upsert({
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
    await workerQueue.enqueue("endpointRegistered", {
      id: endpoint.id,
    });

    return endpoint;
  }
}
