import type {
  CacheService,
  NormalizedResponse,
  PerformedRequestResponse,
} from "internal-integrations";
import { slack } from "internal-integrations";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { IntegrationRequest } from "~/models/integrationRequest.server";
import { getAccessToken } from "../accessToken.server";
import { RedisCacheService } from "../cacheService.server";
import { pizzly } from "../pizzly.server";

type CallResponse =
  | {
      stop: true;
    }
  | {
      stop: false;
      retryInSeconds: number;
    };

export class PerformIntegrationRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string): Promise<CallResponse> {
    const integrationRequest =
      await this.#prismaClient.integrationRequest.findUnique({
        where: { id },
        include: {
          externalService: {
            include: {
              connection: true,
            },
          },
        },
      });

    if (!integrationRequest) {
      return { stop: true };
    }

    if (!integrationRequest.externalService.connection) {
      return { stop: true };
    }

    const accessToken = await getAccessToken(
      integrationRequest.externalService.connection
    );

    if (!accessToken) {
      return { stop: true };
    }

    const cache = new RedisCacheService(
      integrationRequest.externalService.connection.id
    );

    const performedRequest = await this.#performRequest(
      integrationRequest.externalService.connection.apiIdentifier,
      accessToken,
      integrationRequest,
      cache
    );

    if (performedRequest.ok) {
      return this.#completeWithSuccess(
        integrationRequest,
        performedRequest.response
      );
    } else if (performedRequest.isRetryable) {
      return this.#attemptRetry(integrationRequest, performedRequest.response);
    } else {
      return this.#completeWithFailure(
        integrationRequest,
        performedRequest.response
      );
    }
  }

  async #completeWithSuccess(
    integrationRequest: IntegrationRequest,
    response: NormalizedResponse
  ) {
    await this.#createResponse(integrationRequest, response);

    await this.#prismaClient.integrationRequest.update({
      where: {
        id: integrationRequest.id,
      },
      data: {
        status: "SUCCESS",
      },
    });

    await this.#prismaClient.workflowRunStep.update({
      where: {
        id: integrationRequest.stepId,
      },
      data: {
        status: "SUCCESS",
        output: response.body,
        context: {
          headers: response.headers,
          statusCode: response.statusCode,
        },
        finishedAt: new Date(),
      },
    });

    return { stop: true as const };
  }

  async #completeWithFailure(
    integrationRequest: IntegrationRequest,
    response: NormalizedResponse
  ) {
    await this.#createResponse(integrationRequest, response);

    await this.#prismaClient.integrationRequest.update({
      where: {
        id: integrationRequest.id,
      },
      data: {
        status: "ERROR",
      },
    });

    await this.#prismaClient.workflowRunStep.update({
      where: {
        id: integrationRequest.stepId,
      },
      data: {
        status: "ERROR",
        output: response.body,
        context: {
          headers: response.headers,
          statusCode: response.statusCode,
        },
        finishedAt: new Date(),
      },
    });

    return { stop: true as const };
  }

  async #attemptRetry(
    integrationRequest: IntegrationRequest,
    response: NormalizedResponse
  ) {
    if (integrationRequest.retryCount >= 10) {
      await this.#prismaClient.integrationRequest.update({
        where: {
          id: integrationRequest.id,
        },
        data: {
          retryCount: {
            increment: 1,
          },
        },
      });

      return this.#completeWithFailure(integrationRequest, response);
    }

    await this.#createResponse(integrationRequest, response);

    const updatedIntegrationRequest =
      await this.#prismaClient.integrationRequest.update({
        where: {
          id: integrationRequest.id,
        },
        data: {
          status: "RETRYING",
          retryCount: {
            increment: 1,
          },
        },
      });

    return {
      stop: false as const,
      retryInSeconds: this.#calculateRetryInSeconds(
        updatedIntegrationRequest.retryCount
      ),
    };
  }

  // Exponential backoff with a configurable factor and a configurable maximum
  #calculateRetryInSeconds(
    retryCount: number,
    options: { factor: number; maxTimeout: number; minTimeout: number } = {
      factor: 2,
      minTimeout: 1000,
      maxTimeout: Infinity,
    }
  ) {
    const timeout = options.factor ** retryCount * options.minTimeout;

    return Math.min(timeout, options.maxTimeout);
  }

  async #createResponse(
    integrationRequest: IntegrationRequest,
    response: NormalizedResponse
  ) {
    const integrationResponse =
      await this.#prismaClient.integrationResponse.create({
        data: {
          request: {
            connect: {
              id: integrationRequest.id,
            },
          },
          statusCode: response.statusCode,
          headers: response.headers,
          body: response.body ? response.body : undefined,
        },
      });

    return integrationResponse;
  }

  async #performRequest(
    service: string,
    accessToken: string,
    integrationRequest: IntegrationRequest,
    cache: CacheService
  ): Promise<PerformedRequestResponse> {
    switch (service) {
      case "slack": {
        return slack.requests.perform({
          accessToken,
          endpoint: integrationRequest.endpoint,
          params: integrationRequest.params,
          cache,
        });
      }
      default: {
        throw new Error(`Unknown service: ${service}`);
      }
    }
  }
}
