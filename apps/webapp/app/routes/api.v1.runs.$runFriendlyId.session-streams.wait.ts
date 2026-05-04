import { json } from "@remix-run/server-runtime";
import {
  CreateSessionStreamWaitpointRequestBody,
  type CreateSessionStreamWaitpointResponseBody,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { createWaitpointTag, MAX_TAGS_PER_WAITPOINT } from "~/models/waitpointTag.server";
import {
  canonicalSessionAddressingKey,
  isSessionFriendlyIdForm,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  addSessionStreamWaitpoint,
  removeSessionStreamWaitpoint,
} from "~/services/sessionStreamWaitpointCache.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { logger } from "~/services/logger.server";
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

      // Row-optional addressing — see the .out / .in.append handlers.
      // The waitpoint cache + S2 stream key derive from the row's
      // canonical identity (externalId if set, else friendlyId), so
      // the agent's wait registration and the append-side drain
      // converge regardless of which URL form each side used.
      const maybeSession = await resolveSessionByIdOrExternalId(
        $replica,
        authentication.environment.id,
        body.session
      );

      if (!maybeSession && isSessionFriendlyIdForm(body.session)) {
        return json({ error: "Session not found" }, { status: 404 });
      }

      const addressingKey = canonicalSessionAddressingKey(maybeSession, body.session);

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
      // append fires it. Keyed by (addressingKey, io) — the canonical
      // string for the row. The append handler drains by the same
      // canonical key, so writers and readers converge regardless of
      // which URL form the agent vs. the appending caller used.
      const ttlMs = timeout ? timeout.getTime() - Date.now() : undefined;
      await addSessionStreamWaitpoint(
        addressingKey,
        body.io,
        result.waitpoint.id,
        ttlMs && ttlMs > 0 ? ttlMs : undefined
      );

      // Step 3: Race-check. If a record landed on the channel before this
      // .wait() call, complete the waitpoint synchronously with that data
      // and remove the pending registration.
      if (!result.isCached) {
        try {
          // Session streams are always v2 (S2) — the writer in
          // `appendPartToSessionStream` and the SSE subscribe both
          // hardcode "v2", so the race-check reader has to match.
          // Don't fall through to the run's own `realtimeStreamsVersion`,
          // which only describes the run's run-scoped streams.
          //
          // Resolve basin from `session` only (not `run`). The append-side
          // writer in `realtime.v1.sessions.$session.$io.append.ts` passes
          // only `{ session }`, and `resolveStreamBasin` prefers `run` over
          // `session` when both are present. During the per-org-basin
          // migration window, `run.streamBasinName` and
          // `session.streamBasinName` can differ — the writes land in the
          // session's basin, so the race-check has to read from the same.
          const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
            session: maybeSession,
          });

          if (realtimeStream instanceof S2RealtimeStreams) {
            const records = await realtimeStream.readSessionStreamRecords(
              addressingKey,
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
                addressingKey,
                body.io,
                result.waitpoint.id
              );
            }
          }
        } catch (error) {
          // Non-fatal: pending registration stays in Redis; the next append
          // will complete the waitpoint via the append handler path. Log so
          // a broken race-check doesn't silently degrade to timeout-only.
          logger.warn("session-stream wait race-check failed", {
            addressingKey,
            io: body.io,
            waitpointId: WaitpointId.toFriendlyId(result.waitpoint.id),
            error,
          });
        }
      }

      return json<CreateSessionStreamWaitpointResponseBody>({
        waitpointId: WaitpointId.toFriendlyId(result.waitpoint.id),
        isCached: result.isCached,
      });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      }
      // Don't forward raw internal error messages (could leak Prisma/engine
      // details). Log server-side and return a generic 500.
      logger.error("Failed to create session-stream waitpoint", { error });
      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action, loader };
