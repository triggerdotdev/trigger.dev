import { json } from "@remix-run/server-runtime";
import { STREAM_START_HEADER } from "@trigger.dev/core/v3";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
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
  isSessionFriendlyIdForm,
  resolveSessionWithWriterFallback,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  anyResource,
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
  channel: z.string().regex(SESSION_CHANNEL_NAME_REGEX),
  io: z.enum(["out", "in"]),
});

function parsePositiveIntHeader(value: string | null): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "PUT",
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "write",
      resource: (params) => anyResource(sessionChannelResources(params.channel, [params.session])),
    },
  },
  async ({ params, authentication, request }) => {
    if (params.io === "out" && authentication.type !== "PRIVATE") {
      return new Response("Initializing the out channel requires secret key authentication", {
        status: 403,
      });
    }

    const maybeSession = await resolveSessionWithWriterFallback(
      authentication.environment.id,
      params.session
    );

    if (!maybeSession && isSessionFriendlyIdForm(params.session)) {
      return new Response("Session not found", { status: 404 });
    }

    if (maybeSession?.closedAt) {
      return new Response("Cannot initialize a channel on a closed session", { status: 400 });
    }

    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
      session: maybeSession,
      organization: maybeSession ? null : authentication.environment.organization,
    });

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return new Response("Session channels require the S2 realtime backend", { status: 501 });
    }

    const addressingKey = canonicalSessionAddressingKey(maybeSession, params.session);

    const maxAgeSeconds = parsePositiveIntHeader(request.headers.get("x-channel-max-age-seconds"));
    const deleteOnEmptyMinAgeSeconds = parsePositiveIntHeader(
      request.headers.get("x-channel-delete-on-empty-seconds")
    );
    const retention =
      maxAgeSeconds != null || deleteOnEmptyMinAgeSeconds != null
        ? { maxAgeSeconds, deleteOnEmptyMinAgeSeconds }
        : DEFAULT_SESSION_CHANNEL_RETENTION;

    const [retentionError] = await tryCatch(
      realtimeStream.ensureSessionChannelRetention(
        addressingKey,
        params.io,
        params.channel,
        retention
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

    const { responseHeaders } = await realtimeStream.initializeSessionStream(
      addressingKey,
      params.io,
      params.channel
    );

    return json({ version: "v2" }, { status: 202, headers: responseHeaders });
  }
);

const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      const row = await resolveSessionWithWriterFallback(auth.environment.id, params.session);
      if (!row && isSessionFriendlyIdForm(params.session)) {
        return undefined;
      }
      return {
        row,
        addressingKey: canonicalSessionAddressingKey(row, params.session),
      };
    },
    authorization: {
      action: "read",
      resource: ({ row, addressingKey }, params) => {
        const ids = new Set<string>([addressingKey]);
        if (row) {
          ids.add(row.friendlyId);
          if (row.externalId) ids.add(row.externalId);
        }
        return anyResource(sessionChannelResources(params.channel, ids));
      },
    },
  },
  async ({ params, request, authentication, resource }) => {
    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
      session: resource.row,
      organization: resource.row ? null : authentication.environment.organization,
    });

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return new Response("Session channels require the S2 realtime backend", { status: 501 });
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "X-Last-Chunk-Index": "0" } });
    }

    const lastEventId = request.headers.get("Last-Event-ID") ?? undefined;

    const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds");
    let timeoutInSeconds: number | undefined;
    if (timeoutInSecondsRaw) {
      const parsed = Number(timeoutInSecondsRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return new Response("Invalid timeout seconds", { status: 400 });
      }
      if (parsed < 1) {
        return new Response("Timeout seconds must be greater than 0", { status: 400 });
      }
      if (parsed > 600) {
        return new Response("Timeout seconds must be less than 600", { status: 400 });
      }
      timeoutInSeconds = parsed;
    }

    const startFrom =
      request.headers.get(STREAM_START_HEADER)?.toLowerCase() === "latest" ? "latest" : undefined;

    return realtimeStream.streamResponseFromSessionStream(
      request,
      resource.addressingKey,
      params.io,
      getRequestAbortSignal(),
      { lastEventId, timeoutInSeconds, startFrom },
      params.channel
    );
  }
);

export { action, loader };
