import { customAlphabet } from "nanoid";
import { $transaction, prisma, PrismaClient } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { EndpointApi } from "../endpointApi.server";
import { workerQueue } from "../worker.server";

const indexingHookIdentifier = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvxyz",
  10
);

export class CreateEndpointError extends Error {
  code: "FAILED_PING" | "FAILED_UPSERT";
  constructor(code: "FAILED_PING" | "FAILED_UPSERT", message: string) {
    super(message);
    Object.setPrototypeOf(this, CreateEndpointError.prototype);
    this.code = code;
  }
}

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
    const endpointUrl = this.#normalizeEndpointUrl(url);

    const client = new EndpointApi(environment.apiKey, endpointUrl, id);

    const pong = await client.ping();

    if (!pong.ok) {
      throw new CreateEndpointError("FAILED_PING", pong.error);
    }

    try {
      const result = await $transaction(this.#prismaClient, async (tx) => {
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
    if (process.env.RUNTIME_PLATFORM === "docker-compose") {
      const urlObj = new URL(url);

      if (urlObj.hostname === "localhost") {
        urlObj.hostname = "host.docker.internal";
        return urlObj.toString();
      }
    }

    return url;
  }
}
