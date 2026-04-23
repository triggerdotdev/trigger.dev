import { json } from "@remix-run/server-runtime";
import {
  CreateSessionStreamWaitpointRequestBody,
  type CreateSessionStreamWaitpointResponseBody,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { createWaitpointTag, MAX_TAGS_PER_WAITPOINT } from "~/models/waitpointTag.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  addSessionStreamWaitpoint,
  removeSessionStreamWaitpoint,
} from "~/services/sessionStreamWaitpointCache.server";
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
    body: CreateSessionStreamWaitpointRequestBody,
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

      const session = await resolveSessionByIdOrExternalId(
        $replica,
        authentication.environment.id,
        body.session
      );

      if (!session) {
        return json({ error: "Session not found" }, { status: 404 });
      }

      const idempotencyKeyExpiresAt = body.idempotencyKeyTTL
        ? resolveIdempotencyKeyTTL(body.idempotencyKeyTTL)
        : undefined;

      const timeout = await parseDelay(body.timeout);

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

      // Step 1: Create the waitpoint.
      const result = await engine.createManualWaitpoint({
        environmentId: authentication.environment.id,
        projectId: authentication.environment.projectId,
        idempotencyKey: body.idempotencyKey,
        idempotencyKeyExpiresAt,
        timeout,
        tags: bodyTags,
      });

      // Step 2: Register the waitpoint on the session channel so the next
      // append fires it. Keyed by (sessionFriendlyId, io) — both runs on a
      // multi-tab session wake on the same record.
      const ttlMs = timeout ? timeout.getTime() - Date.now() : undefined;
      await addSessionStreamWaitpoint(
        session.friendlyId,
        body.io,
        result.waitpoint.id,
        ttlMs && ttlMs > 0 ? ttlMs : undefined
      );

      // Step 3: Race-check. If a record landed on the channel before this
      // .wait() call, complete the waitpoint synchronously with that data
      // and remove the pending registration.
      if (!result.isCached) {
        try {
          const realtimeStream = getRealtimeStreamInstance(
            authentication.environment,
            run.realtimeStreamsVersion
          );

          if (realtimeStream instanceof S2RealtimeStreams) {
            const records = await realtimeStream.readSessionStreamRecords(
              session.friendlyId,
              body.io,
              body.lastSeqNum
            );

            if (records.length > 0) {
              const record = records[0]!;

              await engine.completeWaitpoint({
                id: result.waitpoint.id,
                output: {
                  value: record.data,
                  type: "application/json",
                  isError: false,
                },
              });

              await removeSessionStreamWaitpoint(
                session.friendlyId,
                body.io,
                result.waitpoint.id
              );
            }
          }
        } catch {
          // Non-fatal: pending registration stays in Redis; the next append
          // will complete the waitpoint via the append handler path.
        }
      }

      return json<CreateSessionStreamWaitpointResponseBody>({
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
