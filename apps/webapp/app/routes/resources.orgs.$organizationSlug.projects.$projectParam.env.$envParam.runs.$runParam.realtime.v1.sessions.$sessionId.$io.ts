import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionWithWriterFallback,
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
  const runWhere = {
    friendlyId: runParam,
    runtimeEnvironmentId: environment.id,
  };
  const runArgs = {
    select: { id: true, friendlyId: true },
  };
  // Replica lag can null out a live run; a spurious 404 breaks the dashboard Agent tab subscription
  // (useRealtimeStream surfaces the error and does not auto-retry). Re-read the primary on a miss.
  const run =
    (await runStore.findRun(runWhere, runArgs, $replica)) ??
    (await runStore.findRunOnPrimary(runWhere, runArgs));

  if (!run) {
    return new Response("Run not found", { status: 404 });
  }

  // Replica lag can null out a just-created session; a spurious 404 breaks the dashboard Agent tab
  // subscription (useRealtimeStream surfaces the error and does not auto-retry). Resolve replica-first
  // with a writer fallback — the same helper the sibling `.in/append` route uses.
  const session = await resolveSessionWithWriterFallback(environment.id, sessionId);

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  // Enforce run ↔ session linkage. Without this, knowledge of a runId in
  // this environment is enough to subscribe to any session in the same
  // environment — defeats the point of scoping subscriptions through the
  // run route. SessionRun.runId is indexed (@unique), so this is cheap.
  // Replica lag can null out the just-created run↔session linkage row; a spurious 404 breaks the
  // dashboard Agent tab subscription (client does not auto-retry). Re-read the primary on a miss.
  const linkWhere = { runId: run.id, sessionId: session.id };
  const linkedSessionRun =
    (await $replica.sessionRun.findFirst({ where: linkWhere, select: { id: true } })) ??
    (await prisma.sessionRun.findFirst({ where: linkWhere, select: { id: true } }));

  if (!linkedSessionRun) {
    return new Response("Session not found for run", { status: 404 });
  }

  const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });

  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return new Response("Session channels require the S2 realtime backend", {
      status: 501,
    });
  }

  const lastEventId = request.headers.get("Last-Event-ID") || undefined;
  const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds");
  let timeoutInSeconds: number | undefined;
  if (timeoutInSecondsRaw !== null) {
    timeoutInSeconds = Number(timeoutInSecondsRaw);
    if (!Number.isInteger(timeoutInSeconds) || timeoutInSeconds < 1 || timeoutInSeconds > 600) {
      return new Response("Invalid timeout", { status: 400 });
    }
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
