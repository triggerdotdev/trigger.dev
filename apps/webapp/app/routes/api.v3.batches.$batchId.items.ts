import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import {
  StreamBatchItemsService,
  createNdjsonParserStream,
  streamToAsyncIterable,
} from "~/runEngine/services/streamBatchItems.server";
import { authenticateApiRequestWithFailure } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { engine } from "~/v3/runEngine.server";

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

  // Authenticate the request
  const authResult = await authenticateApiRequestWithFailure(request, {
    allowPublicKey: true,
  });

  if (!authResult.ok) {
    return json({ error: authResult.error }, { status: 401 });
  }

  // Verify BatchQueue is enabled
  if (!engine.isBatchQueueEnabled()) {
    return json(
      {
        error: "Streaming batch API is not available. BatchQueue is not enabled.",
      },
      { status: 503 }
    );
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

    // Convert to async iterable for the service
    const itemsIterator = streamToAsyncIterable(parsedStream);

    // Process the stream
    const service = new StreamBatchItemsService();
    const result = await service.call(authResult.environment, batchId, itemsIterator, {
      maxItemBytes: env.STREAMING_BATCH_ITEM_MAXIMUM_SIZE,
    });

    return json(result, { status: 200 });
  } catch (error) {
    logger.error("Stream batch items error", {
      batchId,
      error: {
        message: (error as Error).message,
        stack: (error as Error).stack,
      },
    });

    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: 422 });
    } else if (error instanceof Error) {
      // Check for stream parsing errors
      if (
        error.message.includes("Invalid JSON") ||
        error.message.includes("exceeds maximum size")
      ) {
        return json({ error: error.message }, { status: 400 });
      }

      return json(
        { error: error.message },
        { status: 500, headers: { "x-should-retry": "false" } }
      );
    }

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
