import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
  io: z.enum(["out", "in"]),
});

// PUT: initialize the S2 channel for this (session, io) pair — returns S2
// credentials in response headers so the caller can write/read directly
// against S2. GET is handled by the loader below.
const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "PUT",
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "write",
      resource: (params) => ({ sessions: params.session }),
      superScopes: ["write:sessions", "write:all", "admin"],
    },
  },
  async ({ params, authentication }) => {
    const session = await resolveSessionByIdOrExternalId(
      $replica,
      authentication.environment.id,
      params.session
    );

    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    if (session.closedAt) {
      return new Response("Cannot initialize a channel on a closed session", {
        status: 400,
      });
    }

    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2");

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return new Response("Session channels require the S2 realtime backend", {
        status: 501,
      });
    }

    const { responseHeaders } = await realtimeStream.initializeSessionStream(
      session.friendlyId,
      params.io
    );

    return json({ version: "v2" }, { status: 202, headers: responseHeaders });
  }
);

// GET: SSE subscribe to a session channel. HEAD returns the last chunk index
// for resume semantics, mirroring the existing run-stream route.
const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      return resolveSessionByIdOrExternalId($replica, auth.environment.id, params.session);
    },
    authorization: {
      action: "read",
      resource: (session) => {
        const ids = session.externalId
          ? [session.friendlyId, session.externalId]
          : [session.friendlyId];
        return { sessions: ids };
      },
      superScopes: ["read:sessions", "read:all", "admin"],
    },
  },
  async ({ params, request, resource: session, authentication }) => {
    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2");

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return new Response("Session channels require the S2 realtime backend", {
        status: 501,
      });
    }

    if (request.method === "HEAD") {
      // No last-chunk-index on the S2 backend (clients resume via Last-Event-ID
      // on the SSE stream directly). Return 200 with a zero index for
      // compatibility with the run-stream shape.
      return new Response(null, {
        status: 200,
        headers: { "X-Last-Chunk-Index": "0" },
      });
    }

    const lastEventId = request.headers.get("Last-Event-ID") ?? undefined;

    const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds");
    let timeoutInSeconds: number | undefined;
    if (timeoutInSecondsRaw) {
      // `Number()` rejects `"10abc"` as NaN; `parseInt` would silently accept
      // the trailing garbage and bypass the bounds checks below.
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

    // Opt-in: only consider the settled-peek shortcut when the client
    // asks for it via `X-Peek-Settled: 1`. Reconnect-on-reload paths
    // (`TriggerChatTransport.reconnectToStream`) set this; the active
    // send-a-message path (`sendMessages → subscribeToSessionStream`)
    // does not — otherwise the peek races with the newly-triggered
    // turn's first chunk and the SSE closes before records land.
    const peekSettled = request.headers.get("X-Peek-Settled") === "1";

    return realtimeStream.streamResponseFromSessionStream(
      request,
      session.friendlyId,
      params.io,
      getRequestAbortSignal(),
      { lastEventId, timeoutInSeconds, peekSettled }
    );
  }
);

export { action, loader };
