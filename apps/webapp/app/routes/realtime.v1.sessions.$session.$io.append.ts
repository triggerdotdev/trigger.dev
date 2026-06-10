import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { nanoid } from "nanoid";
import { z } from "zod";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { ensureRunForSession } from "~/services/realtime/sessionRunManager.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  drainSessionStreamWaitpoints,
  markSessionStreamPartAppended,
  wasSessionStreamPartAppended,
} from "~/services/sessionStreamWaitpointCache.server";
import {
  anyResource,
  createActionApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const ParamsSchema = z.object({
  session: z.string(),
  io: z.enum(["out", "in"]),
});

// POST: server-side append of a single record to a session channel. Mirrors
// the existing /realtime/v1/streams/:runId/:target/:streamId/append route,
// scoped to a Session primitive.
//
// The HTTP body cap here is just a DoS pre-guard — set generously at
// 1 MiB so we don't buffer arbitrarily large inputs before we can
// compute the wrapped size. The actual S2 per-record limit (verified
// empirically against cloud S2) is enforced precisely inside
// `S2RealtimeStreams.#appendPartByName` — it throws
// `S2RecordTooLargeError` (a `ServiceValidationError` with status
// 413) when the metered record size would exceed S2's 1 MiB ceiling
// after JSON wrapping. That lets legitimate bodies up to ~1023 KiB
// raw through (ASCII or low-escape content) while still rejecting
// pathological all-quote content that would double on wrap.
const MAX_APPEND_BODY_BYTES = 1024 * 1024;

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    maxContentLength: MAX_APPEND_BODY_BYTES,
    allowJWT: true,
    corsStrategy: "all",
    // Sessions are task-bound (created by `POST /api/v1/sessions` which
    // also triggers the first run). The row exists before any caller
    // can reach `.in/append` — no row, no append. Resolved here so the
    // authorization scope can expand to both addressing forms (friendlyId
    // + externalId) and the handler can skip its own lookup.
    findResource: async (params, auth) =>
      resolveSessionByIdOrExternalId($replica, auth.environment.id, params.session),
    authorization: {
      action: "write",
      // Authorize against the union of the URL form, friendlyId, and
      // externalId so a JWT scoped to any form authorizes any URL.
      // Type-level `write:sessions` (no id) also matches; `write:all` /
      // `admin` bypass via the JWT ability's wildcard branches.
      resource: (params, _, __, ___, session) => {
        const ids = new Set<string>([params.session]);
        if (session) {
          ids.add(session.friendlyId);
          if (session.externalId) ids.add(session.externalId);
        }
        return anyResource([...ids].map((id) => ({ type: "sessions", id })));
      },
    },
  },
  async ({ request, params, authentication, resource: session }) => {
    if (!session) {
      // Unreachable — `findResource` short-circuits to 404 before this
      // handler runs. Type-narrow the rest of the body.
      return new Response("Session not found", { status: 404 });
    }

    if (session.closedAt) {
      return json(
        { ok: false, error: "Cannot append to a closed session" },
        { status: 400 }
      );
    }

    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      return json(
        { ok: false, error: "Cannot append to an expired session" },
        { status: 400 }
      );
    }

    // `.out` is the agent→client channel. Only PRIVATE (secret key) auth —
    // i.e. the agent run itself — may write to it. Session-scoped JWTs carry
    // `write:sessions:<key>` for `.in`; without this gate they could forge
    // assistant chunks and complete `.out` waitpoints on their own session.
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

    // Probe + ensure a live run before appending. The append itself is
    // run-independent (S2 stream is durable, keyed on the session) but
    // the message is useless if no run is alive to consume it. The
    // probe is a single Prisma read; ensureRunForSession is no-op when
    // currentRunId is alive, so the steady-state cost is one extra
    // read in the hot path.
    //
    // Best-effort: if ensureRunForSession throws (e.g. the trigger
    // call fails transiently), still append to S2 — the record is
    // durable and the next append will retry the ensure step. Don't
    // surface the error to the caller; the SSE tail just won't deliver
    // it until a run boots.
    const [ensureError] = await tryCatch(
      ensureRunForSession({
        session,
        environment: authentication.environment,
        reason: "continuation",
      })
    );
    if (ensureError) {
      logger.error("Failed to ensureRunForSession on .in/append", {
        sessionId: session.id,
        externalId: session.externalId,
        error: ensureError,
      });
    }

    const addressingKey = canonicalSessionAddressingKey(session, params.session);

    const part = await request.text();
    const clientPartId = request.headers.get("X-Part-Id");
    const partId = clientPartId ?? nanoid(7);

    // Idempotency on client-supplied part ids: a retried POST whose first
    // attempt committed is acknowledged without a second append (which
    // would duplicate the record and double-fire the waitpoint drain).
    // The marker is only written after a successful append, so retries of
    // genuinely failed appends still go through. Server-generated ids are
    // per-request and carry no dedupe meaning.
    if (
      clientPartId &&
      (await wasSessionStreamPartAppended(
        authentication.environment.id,
        addressingKey,
        params.io,
        clientPartId
      ))
    ) {
      return json({ ok: true }, { status: 200 });
    }

    const [appendError] = await tryCatch(
      realtimeStream.appendPartToSessionStream(part, partId, addressingKey, params.io)
    );

    if (appendError) {
      if (appendError instanceof ServiceValidationError) {
        return json(
          { ok: false, error: appendError.message },
          { status: appendError.status ?? 422 }
        );
      }
      logger.error("Failed to append to session stream", {
        sessionId: session.id,
        io: params.io,
        error: appendError,
      });
      return json({ ok: false, error: "Something went wrong, please try again." }, { status: 500 });
    }

    if (clientPartId) {
      await markSessionStreamPartAppended(
        authentication.environment.id,
        addressingKey,
        params.io,
        clientPartId
      );
    }

    // Fire any run-scoped waitpoints registered against this channel. Best
    // effort — a failure here must not fail the append (the record is
    // durable in S2; the SSE tail will still deliver it). Waitpoints are
    // keyed on the canonical addressing key the agent registered with via
    // `sessions.open(...).in.wait()`, so writers and readers converge
    // regardless of which URL form they used.
    const [drainError, waitpointIds] = await tryCatch(
      drainSessionStreamWaitpoints(authentication.environment.id, addressingKey, params.io)
    );
    if (drainError) {
      logger.error("Failed to drain session stream waitpoints", {
        addressingKey,
        io: params.io,
        error: drainError,
      });
    } else if (waitpointIds && waitpointIds.length > 0) {
      await Promise.all(
        waitpointIds.map(async (waitpointId) => {
          const [completeError] = await tryCatch(
            engine.completeWaitpoint({
              id: waitpointId,
              output: {
                value: part,
                type: "application/json",
                isError: false,
              },
            })
          );
          if (completeError) {
            logger.error("Failed to complete session stream waitpoint", {
              addressingKey,
              io: params.io,
              waitpointId,
              error: completeError,
            });
          }
        })
      );
    }

    return json({ ok: true }, { status: 200 });
  }
);

export { action, loader };
