import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import {
  StreamBatchItemsService,
  createNdjsonParserStream,
  streamToAsyncIterable,
} from "~/runEngine/services/streamBatchItems.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import {
  authorizedBatchItemStream,
  BatchItemAuthorizationError,
} from "~/utils/batchItemAuthorization";
import { ServiceValidationError } from "~/v3/services/baseService.server";

const ParamsSchema = z.object({
  batchId: z.string(),
});

/**
 * Phase 2 of 2-phase batch API: Stream batch items.
 *
 * POST /api/v3/batches/:batchId/items
 *
 * Accepts an NDJSON stream of batch items and enqueues them to the BatchQueue.
 * Each line in the body should be a valid BatchItemNDJSON object.
 *
 * The stream is processed with backpressure - items are enqueued as they arrive.
 * The batch is sealed when the stream completes successfully.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  // Validate params
  const paramsResult = ParamsSchema.safeParse(params);
  if (!paramsResult.success) {
    return json({ error: "Invalid batch ID" }, { status: 400 });
  }

  const { batchId } = paramsResult.data;

  // Validate content type
  const contentType = request.headers.get("content-type") || "";
  if (
    !contentType.includes("application/x-ndjson") &&
    !contentType.includes("application/ndjson")
  ) {
    return json(
      {
        error: "Content-Type must be application/x-ndjson or application/ndjson",
      },
      { status: 415 }
    );
  }

  // This streaming route cannot use createActionApiRoute because the body must
  // remain an unread stream. Use the same RBAC controller directly and apply
  // its ability to every parsed item below.
  //
  // Because we bypass the route builder, we also bypass its
  // `restrictedApiKey && !authorization -> 403` fail-closed. Authorization is
  // instead enforced per item by `authorizedBatchItemStream` below, which also
  // requires a restricted credential to present at least one authorized item
  // before the service may touch the batch — otherwise an empty stream would
  // reach it having passed no checks at all. Any logic added between here and
  // that call runs authenticated but NOT authorized, so keep new per-request
  // work behind it.
  const authResult = await rbac.authenticateBearer(request, { allowJWT: true });

  if (!authResult.ok) {
    return json({ error: authResult.error }, { status: authResult.status });
  }

  // Get the request body stream
  const body = request.body;
  if (!body) {
    return json({ error: "Request body is required" }, { status: 400 });
  }

  logger.debug("Stream batch items request", {
    batchId,
    contentType,
    envId: authResult.environment.id,
  });

  try {
    // Create NDJSON parser transform stream
    const parser = createNdjsonParserStream(env.STREAMING_BATCH_ITEM_MAXIMUM_SIZE);

    // Pipe the request body through the parser
    const parsedStream = body.pipeThrough(parser);

    // Convert to async iterable for the service. This authorizes the first item
    // eagerly, so a stream that yields no items is rejected before the service
    // can report anything about the batch.
    const itemsIterator = await authorizedBatchItemStream(
      streamToAsyncIterable(parsedStream),
      authResult.ability,
      batchId
    );

    // Process the stream
    const service = new StreamBatchItemsService();
    const result = await service.call(authResult.environment, batchId, itemsIterator, {
      maxItemBytes: env.STREAMING_BATCH_ITEM_MAXIMUM_SIZE,
      concurrency: env.STREAMING_BATCH_INGEST_CONCURRENCY,
    });

    return json(result, { status: 200 });
  } catch (error) {
    if (error instanceof BatchItemAuthorizationError) {
      return json({ error: "Unauthorized" }, { status: 403 });
    }

    // Customer-facing validation failures (invalid item shape, invalid JSON
    // in the streamed body). The handler returns 4xx with the message;
    // system handles it gracefully, no alert needed.
    if (error instanceof ServiceValidationError) {
      logger.warn("Stream batch items error", { batchId, error: error.message });
      return json({ error: error.message }, { status: 422 });
    }

    if (error instanceof Error && error.message.includes("Invalid JSON")) {
      logger.warn("Stream batch items error: invalid JSON", {
        batchId,
        error: error.message,
      });
      return json({ error: error.message }, { status: 400 });
    }

    logger.error("Stream batch items error", {
      batchId,
      error: {
        message: (error as Error).message,
        stack: (error as Error).stack,
      },
    });

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Return 405 for GET requests - only POST is allowed
  return json(
    {
      error: "Method not allowed. Use POST to stream batch items.",
    },
    { status: 405 }
  );
}
