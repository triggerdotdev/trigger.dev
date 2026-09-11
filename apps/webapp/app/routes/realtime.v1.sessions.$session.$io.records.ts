import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { sessionStreamResources } from "~/services/realtime/sessionChannels.server";
import {
  canonicalSessionAddressingKey,
  isSessionFriendlyIdForm,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
  io: z.enum(["out", "in"]),
});

const SearchSchema = z.object({
  // S2 sequence number — same cursor format as the SSE Last-Event-ID
  // (the SSE `id:` field on session-channel events is the seq_num,
  // stringified). Records returned have `seqNum > afterEventId`.
  afterEventId: z.string().regex(/^\d+$/).optional(),
});

// GET: non-SSE, `wait=0` drain of a session channel. Returns a JSON body
// `{ records: StreamRecord[] }` with whatever records exist after
// `afterEventId` (or from the head if absent) and closes immediately.
//
// Used by the SDK's `replaySessionOutTail` at run boot — the SSE long-poll
// path costs ~1s per fresh chat (the timeout duration) regardless of stream
// content, which is unacceptable on the first-message TTFC budget. This
// route gives the agent a cheap "what's there right now" peek instead.
//
// Same row-optional addressing as the SSE GET route in `…$io.ts`: we
// resolve via `resolveSessionByIdOrExternalId` and only 404 for opaque
// `session_*` friendlyIds (which must reference a real row). External-id
// form falls through with `row: null` so the boot path doesn't 404 on a
// fresh chat that hasn't written its first chunk yet.
export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      const row = await resolveSessionByIdOrExternalId(
        $replica,
        auth.environment.id,
        params.session
      );
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
      // Multi-key: the channel is addressable by the URL key, the row's
      // friendlyId, and (if set) externalId, each also in its direction-folded
      // form (`{key}:out`) so a token narrowed to one direction matches. Type-level
      // `read:sessions` matches any of them; `read:all` / `admin` bypass via the
      // JWT ability's wildcard branches.
      resource: ({ row, addressingKey }, params) => {
        const ids = new Set<string>([addressingKey]);
        if (row) {
          ids.add(row.friendlyId);
          if (row.externalId) ids.add(row.externalId);
        }
        return anyResource(sessionStreamResources(params.io, ids));
      },
    },
  },
  async ({ params, authentication, resource, searchParams }) => {
    // `.in` is the client→agent channel: the agent run reads it, clients only append. A
    // public token is a browser-held credential, and `.in` records can carry data meant
    // for the agent alone (a server-side proxy may inject per-turn credentials), so
    // reading `.in` requires the secret key. `.out` is the only public read.
    if (params.io === "in" && authentication.type !== "PRIVATE") {
      return json(
        { ok: false, error: "Reading the in channel requires secret key authentication" },
        { status: 403 }
      );
    }

    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
      session: resource.row,
      organization: resource.row ? null : authentication.environment.organization,
    });

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return new Response("Session channels require the S2 realtime backend", {
        status: 501,
      });
    }

    const afterSeqNum =
      searchParams.afterEventId !== undefined ? Number(searchParams.afterEventId) : undefined;

    const records = await realtimeStream.readSessionStreamRecords(
      resource.addressingKey,
      params.io,
      afterSeqNum
    );

    return json({ records });
  }
);
