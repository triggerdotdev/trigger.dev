import type { NormalizedResponse } from "internal-integrations";
import { slack } from "internal-integrations";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { IntegrationRequest } from "~/models/integrationRequest.server";
import { pizzly } from "../pizzly.server";

export class PerformIntegrationRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string): Promise<boolean> {
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
      return false;
    }

    if (!integrationRequest.externalService.connection) {
      return false;
    }

    const accessToken = await pizzly.accessToken(
      integrationRequest.externalService.connection.apiIdentifier,
      integrationRequest.externalService.connection.id
    );

    if (!accessToken) {
      return false;
    }

    const response = await this.#performRequest(
      integrationRequest.externalService.connection.apiIdentifier,
      accessToken,
      integrationRequest
    );

    switch (statusCodeToType(response.statusCode)) {
      case "informational": {
        return this.#completeWithSuccess(integrationRequest, response);
      }
      case "success": {
        return this.#completeWithSuccess(integrationRequest, response);
      }
      case "redirect": {
        return this.#completeWithFailure(integrationRequest, response);
      }
      case "clientError": {
        return this.#completeWithFailure(integrationRequest, response);
      }
      case "serverError": {
        return this.#attemptRetry(integrationRequest, response);
      }
      default: {
        return this.#unknownError(integrationRequest, response);
      }
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

    return true;
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

    return true;
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

    return false;
  }

  async #unknownError(
    integrationRequest: IntegrationRequest,
    response: NormalizedResponse
  ) {
    return false;
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
          body: response.body,
        },
      });

    return integrationResponse;
  }

  async #performRequest(
    service: string,
    accessToken: string,
    integrationRequest: IntegrationRequest
  ): Promise<NormalizedResponse> {
    switch (service) {
      case "slack": {
        return slack.requests.perform({
          accessToken,
          endpoint: integrationRequest.endpoint,
          params: integrationRequest.params,
        });
      }
      default: {
        throw new Error(`Unknown service: ${service}`);
      }
    }
  }
}

function statusCodeToType(
  statusCode: number
): "informational" | "success" | "redirect" | "clientError" | "serverError" {
  if (statusCode >= 100 && statusCode < 200) {
    return "informational";
  }

  if (statusCode >= 200 && statusCode < 300) {
    return "success";
  }

  if (statusCode >= 300 && statusCode < 400) {
    return "redirect";
  }

  if (statusCode >= 400 && statusCode < 500) {
    return "clientError";
  }

  if (statusCode >= 500 && statusCode < 600) {
    return "serverError";
  }

  throw new Error(`Unknown status code: ${statusCode}`);
}
