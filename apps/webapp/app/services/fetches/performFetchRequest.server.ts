import type { FetchRequest } from ".prisma/client";
import type { SecureString } from "@trigger.dev/common-schemas";
import { FetchRequestSchema } from "@trigger.dev/common-schemas";
import type {
  NormalizedResponse,
  PerformedRequestResponse,
} from "internal-integrations";
import type { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

type CallResponse =
  | {
      stop: true;
    }
  | {
      stop: false;
      retryInSeconds: number;
    };

export class PerformFetchRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string): Promise<CallResponse> {
    const fetchRequest = await this.#prismaClient.fetchRequest.findUnique({
      where: { id },
    });

    if (!fetchRequest) {
      return { stop: true };
    }

    const performedRequest = await this.#performRequest(fetchRequest);

    if (performedRequest.ok) {
      return this.#completeWithSuccess(fetchRequest, performedRequest.response);
    } else if (performedRequest.isRetryable) {
      return this.#attemptRetry(fetchRequest, performedRequest.response);
    } else {
      return this.#completeWithFailure(fetchRequest, performedRequest.response);
    }
  }

  async #completeWithSuccess(
    fetchRequest: FetchRequest,
    response: NormalizedResponse
  ) {
    await this.#createResponse(fetchRequest, response);

    await this.#prismaClient.fetchRequest.update({
      where: {
        id: fetchRequest.id,
      },
      data: {
        status: "SUCCESS",
      },
    });

    await this.#prismaClient.workflowRunStep.update({
      where: {
        id: fetchRequest.stepId,
      },
      data: {
        status: "SUCCESS",
        output: response.output,
        context: response.context,
        finishedAt: new Date(),
      },
    });

    return { stop: true as const };
  }

  async #completeWithFailure(
    fetchRequest: FetchRequest,
    response: NormalizedResponse
  ) {
    await this.#createResponse(fetchRequest, response);

    await this.#prismaClient.fetchRequest.update({
      where: {
        id: fetchRequest.id,
      },
      data: {
        status: "ERROR",
      },
    });

    await this.#prismaClient.workflowRunStep.update({
      where: {
        id: fetchRequest.stepId,
      },
      data: {
        status: "ERROR",
        output: response.output,
        context: response.context,
        finishedAt: new Date(),
      },
    });

    return { stop: true as const };
  }

  async #attemptRetry(
    fetchRequest: FetchRequest,
    response: NormalizedResponse
  ) {
    if (fetchRequest.retryCount >= 10) {
      await this.#prismaClient.fetchRequest.update({
        where: {
          id: fetchRequest.id,
        },
        data: {
          retryCount: {
            increment: 1,
          },
        },
      });

      return this.#completeWithFailure(fetchRequest, response);
    }

    await this.#createResponse(fetchRequest, response);

    const updatedFetchRequest = await this.#prismaClient.fetchRequest.update({
      where: {
        id: fetchRequest.id,
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
        updatedFetchRequest.retryCount
      ),
    };
  }

  // Exponential backoff with a configurable factor and a configurable maximum
  #calculateRetryInSeconds(
    retryCount: number,
    options: { factor: number; maxTimeout: number; minTimeout: number } = {
      factor: 1.8,
      minTimeout: 1000,
      maxTimeout: 60000,
    }
  ) {
    const timeout = options.factor ** retryCount * options.minTimeout;

    return Math.min(timeout, options.maxTimeout) / 1000;
  }

  async #createResponse(
    fetchRequest: FetchRequest,
    response: NormalizedResponse
  ) {
    const integrationResponse = await this.#prismaClient.fetchResponse.create({
      data: {
        request: {
          connect: {
            id: fetchRequest.id,
          },
        },
        context: response.context,
        output: response.output ? response.output : undefined,
      },
    });

    return integrationResponse;
  }

  async #performRequest(
    fetchRequest: FetchRequest
  ): Promise<PerformedRequestResponse> {
    const request = FetchRequestSchema.parse(fetchRequest.fetch);
    const requestInit = createFetchRequestInit(request);

    const response = await fetch(request.url, requestInit);

    const body = await this.#safeGetJson(response);

    if (response.ok) {
      return {
        ok: true,
        isRetryable: false,
        response: {
          output: {
            status: response.status,
            headers: headersToRecord(response.headers),
            body,
          },
          context: {},
        },
      };
    }

    // Only retry on retryable status codes
    return {
      ok: false,
      isRetryable: RETRYABLE_STATUS_CODES.includes(response.status),
      response: {
        output: {
          status: response.status,
          headers: headersToRecord(response.headers),
          body,
        },
        context: {},
      },
    };
  }

  #safeGetJson = async (response: Response) => {
    try {
      return await response.json();
    } catch (error) {
      return undefined;
    }
  };
}

type FetchRequestOptions = z.infer<typeof FetchRequestSchema>;

function createFetchRequestInit(request: FetchRequestOptions): RequestInit {
  const headers = normalizeHeaders(request.headers);

  return {
    method: request.method,
    headers,
    body: request.body ? JSON.stringify(request.body) : undefined,
  };
}

function normalizeHeaders(
  headers: FetchRequestOptions["headers"]
): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      typeof value === "string" ? value : normalizeSecureString(value),
    ])
  );
}

function normalizeSecureString(value: SecureString): string {
  let result = "";

  for (let i = 0; i < value.strings.length; i++) {
    result += value.strings[i];
    if (i < value.interpolations.length) {
      result += value.interpolations[i];
    }
  }

  return result;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};

  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}
