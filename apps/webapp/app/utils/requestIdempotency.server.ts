import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { logger } from "~/services/logger.server";
import { requestIdempotency } from "~/services/requestIdempotencyInstance.server";
import { startActiveSpan } from "~/v3/tracer.server";

type RequestIdempotencyType = "batch-trigger" | "trigger";

export type IdempotencyConfig<T, R> = {
  requestType: RequestIdempotencyType;
  findCachedEntity: (cachedRequestId: string) => Promise<T | null>;
  buildResponse: (entity: T) => R;
  buildResponseHeaders: (response: R, entity: T) => Promise<Record<string, string>>;
};

export async function handleRequestIdempotency<T, R>(
  requestIdempotencyKey: string | null | undefined,
  config: IdempotencyConfig<T, R>
): Promise<Response | null> {
  if (!requestIdempotencyKey) {
    return null;
  }

  logger.debug(`request-idempotency: checking for cached ${config.requestType} request`, {
    requestIdempotencyKey,
  });

  return startActiveSpan("RequestIdempotency.handle()", async (span) => {
    span.setAttribute("request_idempotency_key", requestIdempotencyKey);

    const cachedRequest = await requestIdempotency.checkRequest(
      config.requestType,
      requestIdempotencyKey
    );

    if (!cachedRequest) {
      span.setAttribute("cached_request", false);

      return null;
    }

    span.setAttribute("cached_request", true);
    span.setAttribute("cached_entity_id", cachedRequest.id);

    logger.info(`request-idempotency: found cached ${config.requestType} request`, {
      requestIdempotencyKey,
      cachedRequest,
    });

    const cachedEntity = await config.findCachedEntity(cachedRequest.id);

    if (!cachedEntity) {
      span.setAttribute("cached_entity", false);

      return null;
    }

    span.setAttribute("cached_entity", true);

    logger.info(`request-idempotency: found cached ${config.requestType} entity`, {
      requestIdempotencyKey,
      cachedRequest,
      cachedEntity,
    });

    const responseBody = config.buildResponse(cachedEntity);
    const responseHeaders = await config.buildResponseHeaders(responseBody, cachedEntity);

    return json(responseBody, { status: 200, headers: responseHeaders });
  });
}

export async function saveRequestIdempotency(
  requestIdempotencyKey: string | null | undefined,
  requestType: RequestIdempotencyType,
  entityId: string
): Promise<void> {
  if (!requestIdempotencyKey) {
    return;
  }

  const [error] = await tryCatch(
    requestIdempotency.saveRequest(requestType, requestIdempotencyKey, {
      id: entityId,
    })
  );

  if (error) {
    logger.error("request-idempotency: error saving request", {
      error,
      requestIdempotencyKey,
      requestType,
      entityId,
    });
  }
}
