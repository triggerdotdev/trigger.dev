import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { nanoid } from "nanoid";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import {
  DEFAULT_SESSION_CHANNEL_RETENTION,
  S2RealtimeStreams,
} from "~/services/realtime/s2realtimeStreams.server";
import {
  SESSION_CHANNEL_NAME_REGEX,
  sessionChannelResources,
} from "~/services/realtime/sessionChannels.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionWithWriterFallback,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  claimSessionStreamPart,
  releaseSessionStreamPart,
} from "~/services/sessionStreamWaitpointCache.server";
import { anyResource, createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const ParamsSchema = z.object({
  session: z.string(),
  channel: z.string().regex(SESSION_CHANNEL_NAME_REGEX),
  io: z.enum(["out", "in"]),
});

const MAX_APPEND_BODY_BYTES = 1024 * 1024;

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    maxContentLength: MAX_APPEND_BODY_BYTES,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) =>
      resolveSessionWithWriterFallback(auth.environment.id, params.session),
    authorization: {
      action: "write",
      resource: (params, _s, _h, _b, session) => {
        const ids = new Set<string>([params.session]);
        if (session) {
          ids.add(session.friendlyId);
          if (session.externalId) ids.add(session.externalId);
        }
        return anyResource(sessionChannelResources(params.channel, ids));
      },
    },
  },
  async ({ request, params, authentication, resource: session }) => {
    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    if (session.closedAt) {
      return json({ ok: false, error: "Cannot append to a closed session" }, { status: 400 });
    }

    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      return json({ ok: false, error: "Cannot append to an expired session" }, { status: 400 });
    }

    if (params.io === "out" && authentication.type !== "PRIVATE") {
      return json(
        { ok: false, error: "Appending to the out channel requires secret key authentication" },
        { status: 403 }
      );
    }

    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
      session,
    });

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return json(
        { ok: false, error: "Session channels require the S2 realtime backend" },
        { status: 501 }
      );
    }

    const addressingKey = canonicalSessionAddressingKey(session, params.session);

    const [retentionError] = await tryCatch(
      realtimeStream.ensureSessionChannelRetention(
        addressingKey,
        params.io,
        params.channel,
        DEFAULT_SESSION_CHANNEL_RETENTION
      )
    );
    if (retentionError) {
      logger.warn("Failed to ensure session channel retention", {
        addressingKey,
        channel: params.channel,
        io: params.io,
        error: retentionError,
      });
    }

    const claimKey = `${addressingKey}:channels:${params.channel}`;

    const part = await request.text();

    const clientPartId = request.headers.get("X-Part-Id");
    const partId = clientPartId ?? nanoid(7);

    const wonClaim = clientPartId
      ? await claimSessionStreamPart(
          authentication.environment.id,
          claimKey,
          params.io,
          clientPartId
        )
      : true;

    let appendSeq: number | undefined;
    if (wonClaim) {
      const [appendError, seq] = await tryCatch(
        realtimeStream.appendPartToSessionStream(
          part,
          partId,
          addressingKey,
          params.io,
          params.channel
        )
      );
      appendSeq = seq ?? undefined;

      if (appendError) {
        if (clientPartId) {
          await releaseSessionStreamPart(
            authentication.environment.id,
            claimKey,
            params.io,
            clientPartId
          );
        }
        if (appendError instanceof ServiceValidationError) {
          return json(
            { ok: false, error: appendError.message },
            { status: appendError.status ?? 422 }
          );
        }
        logger.error("Failed to append to session channel stream", {
          sessionId: session.id,
          io: params.io,
          channel: params.channel,
          error: appendError,
        });
        return json(
          { ok: false, error: "Something went wrong, please try again." },
          { status: 500 }
        );
      }
    }

    return json({ ok: true, seq: appendSeq }, { status: 200 });
  }
);

export { action, loader };
