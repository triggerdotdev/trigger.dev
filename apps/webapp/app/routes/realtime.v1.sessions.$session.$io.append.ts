import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { nanoid } from "nanoid";
import { z } from "zod";
import { $replica } from "~/db.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const ParamsSchema = z.object({
  session: z.string(),
  io: z.enum(["out", "in"]),
});

// POST: server-side append of a single record to a session channel. Mirrors
// the existing /realtime/v1/streams/:runId/:target/:streamId/append route,
// scoped to a Session primitive.
// S2 enforces a 1 MiB per-record limit (metered as
// `8 + 2*H + Σ(header name+value) + body`). We cap the raw HTTP body at
// 512 KiB so the JSON wrapper (`{"data":"...","id":"..."}`), string
// escaping, and any future per-record header additions all stay comfortably
// below S2's ceiling. See https://s2.dev/docs/limits.
const MAX_APPEND_BODY_BYTES = 1024 * 512;

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    maxContentLength: MAX_APPEND_BODY_BYTES,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "write",
      resource: (params) => ({ sessions: params.session }),
      superScopes: ["write:sessions", "write:all", "admin"],
    },
  },
  async ({ request, params, authentication }) => {
    const session = await resolveSessionByIdOrExternalId(
      $replica,
      authentication.environment.id,
      params.session
    );

    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    if (session.closedAt) {
      return json(
        { ok: false, error: "Cannot append to a closed session" },
        { status: 400 }
      );
    }

    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2");

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return json(
        { ok: false, error: "Session channels require the S2 realtime backend" },
        { status: 501 }
      );
    }

    const part = await request.text();
    const partId = request.headers.get("X-Part-Id") ?? nanoid(7);

    const [appendError] = await tryCatch(
      realtimeStream.appendPartToSessionStream(part, partId, session.friendlyId, params.io)
    );

    if (appendError) {
      if (appendError instanceof ServiceValidationError) {
        return json(
          { ok: false, error: appendError.message },
          { status: appendError.status ?? 422 }
        );
      }
      return json({ ok: false, error: appendError.message }, { status: 500 });
    }

    return json({ ok: true }, { status: 200 });
  }
);

export { action };
