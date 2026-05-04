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
  runParam: z.string(),
  sessionId: z.string(),
  io: z.enum(["out", "in"]),
});

// GET: SSE stream subscription for a backing Session's `.out` / `.in`
// channel. Dashboard-auth counterpart to the public API's
// `/realtime/v1/sessions/:sessionId/:io` endpoint. Used by the Agent tab
// in the span inspector to observe assistant chunks (`.out`) and
// user-side ChatInputChunk payloads (`.in`) for a chat.agent run.
//
// The `:sessionId` segment accepts either the `session_*` friendlyId or
// the externalId the transport registered for the chat (typically the
// browser's `chatId`). Runs pre-dating the Sessions migration that have
// `chatId` but no `sessionId` in the payload take the externalId path.
//
// Authenticated by the dashboard session — the user must have access to
// the project, environment, and run. The run binds this resource
// hierarchy; the session identity is verified against the environment.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { runParam, sessionId, io } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return new Response("Environment not found", { status: 404 });
  }

  // Verify the run lives in this environment — keeps callers from
  // subscribing to arbitrary sessions via `/runs/$runParam/...`.
  const run = await $replica.taskRun.findFirst({
    where: {
      friendlyId: runParam,
      runtimeEnvironmentId: environment.id,
    },
    select: { id: true, friendlyId: true },
  });

  if (!run) {
    return new Response("Run not found", { status: 404 });
  }

  const session = await resolveSessionByIdOrExternalId(
    $replica,
    environment.id,
    sessionId
  );

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
  const addressingKey = canonicalSessionAddressingKey(session, sessionId);

  return realtimeStream.streamResponseFromSessionStream(
    request,
    addressingKey,
    io,
    getRequestAbortSignal(),
    { lastEventId, timeoutInSeconds }
  );
}
