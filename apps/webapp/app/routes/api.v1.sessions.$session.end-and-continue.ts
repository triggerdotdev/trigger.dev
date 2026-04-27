import { json } from "@remix-run/server-runtime";
import {
  EndAndContinueSessionRequestBody,
  type EndAndContinueSessionResponseBody,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { swapSessionRun } from "~/services/realtime/sessionRunManager.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
});

// POST /api/v1/sessions/:session/end-and-continue
//
// Generic "the running run is exiting; please trigger a fresh one for
// this session and swap `currentRunId` to it" endpoint. The agent calls
// this from `chat.requestUpgrade` and other planned-handoff paths. The
// transport's `.out` SSE keeps streaming across the swap because S2 is
// keyed on the session, not the run — v1's last chunks land, v2's new
// chunks land on the same stream.
//
// Auth: `write:sessions:{ext}` — the running agent's internal API key
// (PRIVATE) bypasses authorization; a browser holding the session PAT
// can also reach this endpoint, which is fine: if you have the session
// PAT, you own the chat.
const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: EndAndContinueSessionRequestBody,
    method: "POST",
    maxContentLength: 1024,
    allowJWT: true,
    corsStrategy: "all",
    // Resolved before authorization so the auth scope can expand to both
    // addressing forms (friendlyId + externalId). Handler reads the row
    // from `resource` instead of re-fetching.
    findResource: async (params, auth) =>
      resolveSessionByIdOrExternalId($replica, auth.environment.id, params.session),
    authorization: {
      action: "write",
      resource: (params, _, __, ___, session) => {
        const ids = new Set<string>([params.session]);
        if (session) {
          ids.add(session.friendlyId);
          if (session.externalId) ids.add(session.externalId);
        }
        return { sessions: [...ids] };
      },
      superScopes: ["write:sessions", "write:all", "admin"],
    },
  },
  async ({ authentication, params, body, resource: session }) => {
    if (!session) {
      // Unreachable — `findResource` 404s before this runs. Type narrow.
      return json({ error: "Session not found" }, { status: 404 });
    }

    if (session.closedAt) {
      return json(
        { error: "Cannot end-and-continue a closed session" },
        { status: 400 }
      );
    }

    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      return json(
        { error: "Cannot end-and-continue an expired session" },
        { status: 400 }
      );
    }

    // The wire `callingRunId` is a friendlyId (that's what the agent
    // SDK exposes via `ctx.run.id`). Internally `Session.currentRunId`
    // stores the TaskRun.id cuid, so resolve before handing to the
    // optimistic-claim service.
    const callingRun = await $replica.taskRun.findFirst({
      where: {
        friendlyId: body.callingRunId,
        runtimeEnvironmentId: authentication.environment.id,
      },
      select: { id: true },
    });
    if (!callingRun) {
      return json({ error: "callingRunId not found in this environment" }, { status: 404 });
    }

    try {
      // Body's `reason` is free-form for forward-compat (audit metadata
      // only); narrow into the closed `EnsureRunReason` set, defaulting
      // to `"manual"` for unknown labels.
      const reason: "initial" | "continuation" | "upgrade" | "manual" =
        body.reason === "upgrade" ||
        body.reason === "continuation" ||
        body.reason === "initial" ||
        body.reason === "manual"
          ? body.reason
          : "manual";

      const result = await swapSessionRun({
        session,
        callingRunId: callingRun.id,
        environment: authentication.environment,
        reason,
      });

      // The swap stored a TaskRun.id (cuid) in `currentRunId`; surface
      // the friendlyId for parity with the rest of the public API.
      const run = await $replica.taskRun.findFirst({
        where: { id: result.runId },
        select: { friendlyId: true },
      });

      const responseBody: EndAndContinueSessionResponseBody = {
        runId: run?.friendlyId ?? result.runId,
        swapped: result.swapped,
      };
      return json<EndAndContinueSessionResponseBody>(responseBody);
    } catch (error) {
      logger.error("Failed end-and-continue", {
        sessionId: session.id,
        error,
      });
      return json({ error: "Failed to swap session run" }, { status: 500 });
    }
  }
);

export { action };
