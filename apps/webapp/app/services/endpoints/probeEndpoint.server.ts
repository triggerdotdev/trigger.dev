import { MAX_RUN_CHUNK_EXECUTION_LIMIT } from "~/consts";
import { prisma, type PrismaClient } from "~/db.server";
import { EndpointApi } from "../endpointApi.server";
import { logger } from "../logger.server";
import { detectResponseIsTimeout } from "~/models/endpoint.server";

export class ProbeEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const endpoint = await this.#prismaClient.endpoint.findUnique({
      where: {
        id,
      },
      include: {
        environment: true,
      },
    });

    if (!endpoint) {
      return;
    }

    logger.debug(`Probing endpoint`, {
      id,
    });

    if (!endpoint.url) {
      logger.debug(`Endpoint has no url`, {
        id,
      });
      return;
    }

    const client = new EndpointApi(endpoint.environment.apiKey, endpoint.url);

    const { response, durationInMs } = await client.probe(MAX_RUN_CHUNK_EXECUTION_LIMIT);

    if (!response) {
      return;
    }

    logger.debug(`Probing endpoint complete`, {
      id,
      durationInMs,
      response: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      },
    });

    const rawBody = await response.text();

    // If the response is a 200, or it was a timeout, we can assume the endpoint is up and update the runChunkExecutionLimit
    if (response.status === 200 || detectResponseIsTimeout(rawBody, response)) {
      await this.#prismaClient.endpoint.update({
        where: {
          id,
        },
        data: {
          runChunkExecutionLimit: Math.min(
            Math.max(durationInMs, 10000),
            MAX_RUN_CHUNK_EXECUTION_LIMIT
          ),
        },
      });
    }
  }
}
