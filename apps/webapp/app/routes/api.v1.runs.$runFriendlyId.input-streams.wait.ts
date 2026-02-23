import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  CreateInputStreamWaitpointRequestBody,
  type CreateInputStreamWaitpointResponseBody,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { createWaitpointTag, MAX_TAGS_PER_WAITPOINT } from "~/models/waitpointTag.server";
import {
  deleteInputStreamWaitpoint,
  setInputStreamWaitpoint,
} from "~/services/inputStreamWaitpointCache.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { parseDelay } from "~/utils/delays";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { engine } from "~/v3/runEngine.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

const ParamsSchema = z.object({
  runFriendlyId: z.string(),
});

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: CreateInputStreamWaitpointRequestBody,
    maxContentLength: 1024 * 10, // 10KB
    method: "POST",
  },
  async ({ authentication, body, params }) => {
    try {
      const run = await $replica.taskRun.findFirst({
        where: {
          friendlyId: params.runFriendlyId,
          runtimeEnvironmentId: authentication.environment.id,
        },
        select: {
          id: true,
          friendlyId: true,
          realtimeStreamsVersion: true,
        },
      });

      if (!run) {
        return json({ error: "Run not found" }, { status: 404 });
      }

      const idempotencyKeyExpiresAt = body.idempotencyKeyTTL
        ? resolveIdempotencyKeyTTL(body.idempotencyKeyTTL)
        : undefined;

      const timeout = await parseDelay(body.timeout);

      // Process tags (same pattern as api.v1.waitpoints.tokens.ts)
      const bodyTags = typeof body.tags === "string" ? [body.tags] : body.tags;

      if (bodyTags && bodyTags.length > MAX_TAGS_PER_WAITPOINT) {
        throw new ServiceValidationError(
          `Waitpoints can only have ${MAX_TAGS_PER_WAITPOINT} tags, you're trying to set ${bodyTags.length}.`
        );
      }

      if (bodyTags && bodyTags.length > 0) {
        for (const tag of bodyTags) {
          await createWaitpointTag({
            tag,
            environmentId: authentication.environment.id,
            projectId: authentication.environment.projectId,
          });
        }
      }

      // Step 1: Create the waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authentication.environment.id,
        projectId: authentication.environment.projectId,
        idempotencyKey: body.idempotencyKey,
        idempotencyKeyExpiresAt,
        timeout,
        tags: bodyTags,
      });

      // Step 2: Cache the mapping in Redis for fast lookup from .send()
      const ttlMs = timeout ? timeout.getTime() - Date.now() : undefined;
      await setInputStreamWaitpoint(
        run.friendlyId,
        body.streamId,
        result.waitpoint.id,
        ttlMs && ttlMs > 0 ? ttlMs : undefined
      );

      // Step 3: Check if data was already sent to this input stream (race condition handling).
      // If .send() landed before .wait(), the data is in the S2 stream but no waitpoint
      // existed to complete. We check from the client's last known position.
      if (!result.isCached) {
        try {
          const realtimeStream = getRealtimeStreamInstance(
            authentication.environment,
            run.realtimeStreamsVersion
          );

          if (realtimeStream.readRecords) {
            const records = await realtimeStream.readRecords(
              run.friendlyId,
              `$trigger.input:${body.streamId}`,
              body.lastSeqNum
            );

            if (records.length > 0) {
              const record = records[0]!;

              // Record data is the raw user payload — no wrapper to unwrap
              await engine.completeWaitpoint({
                id: result.waitpoint.id,
                output: {
                  value: record.data,
                  type: "application/json",
                  isError: false,
                },
              });

              // Clean up the Redis cache since we completed it ourselves
              await deleteInputStreamWaitpoint(run.friendlyId, body.streamId);
            }
          }
        } catch {
          // Non-fatal: if the S2 check fails, the waitpoint is still PENDING.
          // The next .send() will complete it via the Redis cache path.
        }
      }

      return json<CreateInputStreamWaitpointResponseBody>({
        waitpointId: WaitpointId.toFriendlyId(result.waitpoint.id),
        isCached: result.isCached,
      });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      } else if (error instanceof Error) {
        return json({ error: error.message }, { status: 500 });
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action, loader };
