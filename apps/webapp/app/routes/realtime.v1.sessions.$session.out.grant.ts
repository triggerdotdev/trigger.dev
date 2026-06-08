import { json } from "@remix-run/server-runtime";
import { type SessionDirectReadGrant } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  canonicalSessionAddressingKey,
  isSessionFriendlyIdForm,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  anyResource,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
});

const SearchParamsSchema = z.object({
  // `peek=1` is sent on the reconnect handshake: do the settled-peek
  // server-side (next to S2) and return the verdict alongside the grant so the
  // client doesn't make its own client→S2 peek round-trip. Absent on the
  // active send path (no verdict needed there).
  peek: z.string().optional(),
});

/**
 * GET /realtime/v1/sessions/:session/out/grant
 *
 * Mint a fresh direct-read grant for a session's `.out` stream so the client
 * can keep reading directly from S2 without the token expiring mid-session.
 * Lightweight: authed by the session PAT the client already holds, no run
 * trigger, no DB write. Returns `{ directReadOut: null }` when direct reads
 * aren't available (flag off, or a backend that can't mint scoped tokens) so
 * the client transparently stays on the proxied read.
 */
const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchParamsSchema,
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
      return {
        row,
        addressingKey: canonicalSessionAddressingKey(row, params.session),
      };
    },
    authorization: {
      action: "read",
      resource: ({ row, addressingKey }) => {
        const ids = new Set<string>([addressingKey]);
        if (row) {
          ids.add(row.friendlyId);
          if (row.externalId) ids.add(row.externalId);
        }
        return anyResource([...ids].map((id) => ({ type: "sessions", id })));
      },
    },
  },
  async ({ authentication, resource, searchParams }) => {
    let directReadOut: SessionDirectReadGrant | null = null;
    // Reconnect settled-peek verdict, returned only when the client asks for
    // it (`?peek=1`). `settled` undefined means "not peeked / unavailable" —
    // the client then does its own peek.
    let settled: boolean | undefined;
    let tailSeq: number | undefined;

    if (env.REALTIME_STREAMS_SESSIONS_DIRECT_READ_ENABLED === "true") {
      const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
        session: resource.row,
        organization: resource.row ? null : authentication.environment.organization,
      });

      if (realtimeStream instanceof S2RealtimeStreams) {
        const grant = await realtimeStream.issueSessionOutReadGrant(resource.addressingKey);
        if (grant) {
          directReadOut = { provider: "s2", ...grant };

          // Piggyback the settled-peek on the grant fetch the reconnecting
          // client is already making — done here next to S2 (sub-ms) so the
          // client can pick direct-drain vs direct-stream without its own peek.
          if (searchParams.peek === "1") {
            const verdict = await realtimeStream.peekSessionOutSettled(resource.addressingKey);
            settled = verdict.settled;
            tailSeq = verdict.tailSeq;
          }
        }
      }
    }

    return json({ directReadOut, settled, tailSeq });
  }
);

export { loader };
