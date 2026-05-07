import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  sessionParam: z.string(),
  io: z.enum(["out", "in"]),
});

// GET: SSE stream subscription for a Session's `.out` / `.in` channel.
// Dashboard-auth counterpart to the public API's
// `/realtime/v1/sessions/:sessionId/:io`. Used by the Sessions detail
// view (and the run page's Agent tab) to observe assistant chunks
// (`.out`) and user-side ChatInputChunk payloads (`.in`).
//
// The `:sessionParam` segment accepts either the `session_*` friendlyId
// or the externalId the transport registered for the chat (typically the
// browser's `chatId`).
//
// Authenticated by the dashboard session — the user must have access to
// the project and environment. The session must live in that environment.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { sessionParam, io } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return new Response("Environment not found", { status: 404 });
  }

  const session = await resolveSessionByIdOrExternalId($replica, environment.id, sessionParam);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });

  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return new Response("Session channels require the S2 realtime backend", {
      status: 501,
    });
  }

  const lastEventId = request.headers.get("Last-Event-ID") || undefined;
  const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds") ?? undefined;
  const timeoutInSeconds = timeoutInSecondsRaw ? parseInt(timeoutInSecondsRaw) : undefined;

  if (
    timeoutInSeconds &&
    (isNaN(timeoutInSeconds) || timeoutInSeconds < 1 || timeoutInSeconds > 600)
  ) {
    return new Response("Invalid timeout", { status: 400 });
  }

  // The agent writes via the canonical addressing key (externalId if
  // set, else friendlyId). Subscribe with the same key so the read
  // hits the same S2 stream the agent is writing into.
  const addressingKey = canonicalSessionAddressingKey(session, sessionParam);

  return realtimeStream.streamResponseFromSessionStream(
    request,
    addressingKey,
    io,
    getRequestAbortSignal(),
    { lastEventId, timeoutInSeconds }
  );
}
