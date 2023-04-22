import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi } from "../clientApi.server";
import { getConnectionAuths } from "../connectionAuth.server";

export class PrepareJobInstanceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const jobInstance = await this.#prismaClient.jobInstance.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        connections: true,
        job: true,
        endpoint: {
          include: {
            environment: true,
          },
        },
      },
    });

    const client = new ClientApi(
      jobInstance.endpoint.environment.apiKey,
      jobInstance.endpoint.url
    );

    const response = await client.prepareForJobExecution({
      id: jobInstance.job.slug,
      version: jobInstance.version,
      connections: await getConnectionAuths(jobInstance.connections),
    });

    if (!response.ok) {
      throw new Error("Something went wrong when preparing a job instance");
    }

    await this.#prismaClient.jobInstance.update({
      where: {
        id,
      },
      data: {
        ready: true,
      },
    });
  }
}
