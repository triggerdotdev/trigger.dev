import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  canonicalSessionAddressingKey,
  isSessionFriendlyIdForm,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
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
      resource: (params) => ({ type: "sessions", id: params.session }),
    },
  },
  async ({ params, authentication }) => {
    // Row-optional addressing. The agent calls PUT initialize as part
    // of `session.out.writer()`, by which time it has already created
    // the row at bind, so a missing row here is an unusual case
    // (manual init from outside chat.agent). Require a real row only
    // for opaque friendlyIds, and treat closedAt as a soft reject only
    // when a row exists. The S2 stream key is built from the row's
    // canonical key (externalId if set, else friendlyId) so writers
    // and readers converge regardless of URL form.
    const maybeSession = await resolveSessionByIdOrExternalId(
      $replica,
      authentication.environment.id,
      params.session
    );

    if (!maybeSession && isSessionFriendlyIdForm(params.session)) {
      return new Response("Session not found", { status: 404 });
    }

    if (maybeSession?.closedAt) {
      return new Response("Cannot initialize a channel on a closed session", {
        status: 400,
      });
    }

    // No-row form: resolve via the org so the stream initialised here
    // matches what later appends/subscribes will land on once the row
    // is created.
    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
      session: maybeSession,
      organization: maybeSession ? null : authentication.environment.organization,
    });

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return new Response("Session channels require the S2 realtime backend", {
        status: 501,
      });
    }

    const addressingKey = canonicalSessionAddressingKey(maybeSession, params.session);

    const { responseHeaders } = await realtimeStream.initializeSessionStream(
      addressingKey,
      params.io
    );

    return json({ version: "v2" }, { status: 202, headers: responseHeaders });
  }
);

// GET: SSE subscribe to a session channel. HEAD returns the last chunk index
// for resume semantics, mirroring the existing run-stream route.
//
// Subscribes are row-optional: the chat.agent transport opens the SSE on
// `chatId` (externalId) before the agent has booted and upserted the
// Session row. The S2 stream is keyed on the row's *canonical* identity
// (externalId if set, else friendlyId) so two callers addressing the
// same row via different URL forms converge on the same stream. We
// short-circuit to 404 only for opaque `session_*` friendlyIds (those
// must come from a real mint).
const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      const row = await resolveSessionByIdOrExternalId(
        $replica,
        auth.environment.id,
        params.session
      );
      if (!row && isSessionFriendlyIdForm(params.session)) {
        return undefined; // 404 — opaque friendlyId must reference a real row
      }
      // Non-null wrapper so missing row doesn't 404 for externalId form.
      return {
        row,
        addressingKey: canonicalSessionAddressingKey(row, params.session),
      };
    },
    authorization: {
      action: "read",
      // Multi-key: the channel is addressable by the URL key, the row's
      // friendlyId, and (if set) externalId. Type-level `read:sessions`
      // matches any of them; `read:all` / `admin` bypass via the JWT
      // ability's wildcard branches.
      resource: ({ row, addressingKey }) => {
        const ids = new Set<string>([addressingKey]);
        if (row) {
          ids.add(row.friendlyId);
          if (row.externalId) ids.add(row.externalId);
        }
        return [...ids].map((id) => ({ type: "sessions", id }));
      },
    },
  },
  async ({ params, request, authentication, resource }) => {
    // Same no-row fallback as PUT above.
    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
      session: resource.row,
      organization: resource.row ? null : authentication.environment.organization,
    });

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
      resource.addressingKey,
      params.io,
      getRequestAbortSignal(),
      { lastEventId, timeoutInSeconds, peekSettled }
    );
  }
);

export { action, loader };
