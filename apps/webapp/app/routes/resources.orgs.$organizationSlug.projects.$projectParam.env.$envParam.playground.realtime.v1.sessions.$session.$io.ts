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
  session: z.string(),
  io: z.enum(["out", "in"]),
});

// HEAD/GET: SSE subscribe to a Session channel from the dashboard
// playground. Mirrors the public `GET /realtime/v1/sessions/:session/:io`
// route but authenticates via the dashboard session cookie instead of a
// session-scoped JWT — the playground transport never holds a PAT.
//
// `:session` accepts either the `session_*` friendlyId or the externalId
// the playground assigned (`chatId`). Resolution is environment-scoped
// so users can't subscribe to sessions from other envs.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { session: sessionParam, io } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return new Response("Environment not found", { status: 404 });
  }

  const session = await resolveSessionByIdOrExternalId(
    $replica,
    environment.id,
    sessionParam
  );

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const realtimeStream = getRealtimeStreamInstance(environment, "v2");

  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return new Response("Session channels require the S2 realtime backend", {
      status: 501,
    });
  }

  if (request.method === "HEAD") {
    // No last-chunk-index on the S2 backend (clients resume via
    // Last-Event-ID on the SSE stream directly). Return 200 with a
    // zero index for compatibility with the run-stream shape.
    return new Response(null, {
      status: 200,
      headers: { "X-Last-Chunk-Index": "0" },
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

  const addressingKey = canonicalSessionAddressingKey(session, sessionParam);

  return realtimeStream.streamResponseFromSessionStream(
    request,
    addressingKey,
    io,
    getRequestAbortSignal(),
    { lastEventId, timeoutInSeconds }
  );
}
