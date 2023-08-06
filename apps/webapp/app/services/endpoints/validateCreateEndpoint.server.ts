import { customAlphabet } from "nanoid";
import { $transaction, prisma, PrismaClient } from "~/db.server";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { workerQueue } from "../worker.server";
import { CreateEndpointError } from "./createEndpoint.server";
import { EndpointApi } from "../endpointApi.server";

const indexingHookIdentifier = customAlphabet("0123456789abcdefghijklmnopqrstuvxyz", 10);

export class ValidateCreateEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ environment, url }: { environment: AuthenticatedEnvironment; url: string }) {
    const endpointUrl = this.#normalizeEndpointUrl(url);

    const client = new EndpointApi(environment.apiKey, endpointUrl);

    const validationResult = await client.validate();

    if (!validationResult.ok) {
      throw new Error(validationResult.error);
    }

    try {
      const result = await $transaction(this.#prismaClient, async (tx) => {
        const endpoint = await tx.endpoint.upsert({
          where: {
            environmentId_slug: {
              environmentId: environment.id,
              slug: validationResult.endpointId,
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
            slug: validationResult.endpointId,
            url: endpointUrl,
            indexingHookIdentifier: indexingHookIdentifier(),
          },
          update: {
            url: endpointUrl,
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

      return result;
    } catch (error) {
      if (error instanceof Error) {
        throw new CreateEndpointError("FAILED_UPSERT", error.message);
      } else {
        throw new CreateEndpointError("FAILED_UPSERT", "Something went wrong");
      }
    }
  }

  // If the endpoint URL points to localhost, and the RUNTIME_PLATFORM is docker-compose, then we need to rewrite the host to host.docker.internal
  // otherwise we shouldn't change anything
  #normalizeEndpointUrl(url: string) {
    if (env.RUNTIME_PLATFORM === "docker-compose") {
      const urlObj = new URL(url);

      if (urlObj.hostname === "localhost") {
        urlObj.hostname = "host.docker.internal";
        return urlObj.toString();
      }
    }

    return url;
  }
}
