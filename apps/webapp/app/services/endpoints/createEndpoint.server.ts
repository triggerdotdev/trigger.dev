import type { Organization, RuntimeEnvironment } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi } from "../clientApi.server";
import { workerQueue } from "../worker.server";

export class CreateEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    organization,
    url,
    name,
  }: {
    environment: RuntimeEnvironment;
    organization: Organization;
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
            id: organization.id,
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
