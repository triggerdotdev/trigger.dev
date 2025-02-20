import {
  apiClientManager,
  ApiPromise,
  ApiRequestOptions,
  CreateWaitpointRequestBody,
  CreateWaitpointResponseBody,
  mergeRequestOptions,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

function createResumeToken(
  options?: CreateWaitpointRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<CreateWaitpointResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "resumeTokens.create()",
      icon: "wait",
      attributes: {
        idempotencyKey: options?.idempotencyKey,
        idempotencyKeyTTL: options?.idempotencyKeyTTL,
        timeout: options?.timeout
          ? typeof options.timeout === "string"
            ? options.timeout
            : options.timeout.toISOString()
          : undefined,
      },
      onResponseBody: (body: CreateWaitpointResponseBody, span) => {
        span.setAttribute("id", body.id);
        span.setAttribute("isCached", body.isCached);
      },
    },
    requestOptions
  );

  return apiClient.createResumeToken(options ?? {}, $requestOptions);
}

export const resumeTokens = {
  create: createResumeToken,
};
