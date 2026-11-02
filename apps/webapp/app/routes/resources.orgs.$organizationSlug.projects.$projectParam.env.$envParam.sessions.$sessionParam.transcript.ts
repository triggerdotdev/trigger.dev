import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import {
  DASHBOARD_TRANSCRIPT_PAGE,
  readSessionTranscriptSeed,
} from "~/services/realtime/transcriptSeed.server";
import { requireUserId } from "~/services/session.server";
import { $replica } from "~/db.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  sessionParam: z.string(),
});

const SearchParamsSchema = z.object({
  before: z.string().optional(),
});

// GET: a page of a Session's saved transcript. Without `before` it's the most
// recent page, which the Conversation tab fetches when the session page opened
// on the Trace tab; with `before`, an earlier page for "load earlier messages".
// Dashboard-auth counterpart to the public API's `/api/v1/sessions/:sessionId/transcript`.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { sessionParam } = ParamsSchema.parse(params);
  const { before } = SearchParamsSchema.parse(
    Object.fromEntries(new URL(request.url).searchParams)
  );

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const session = await resolveSessionByIdOrExternalId($replica, environment.id, sessionParam);
  if (!session) {
    return json({ error: "Session not found" }, { status: 404 });
  }

  const seed = await readSessionTranscriptSeed({
    session,
    projectRef: project.externalRef,
    envSlug: environment.slug,
    limit: DASHBOARD_TRANSCRIPT_PAGE,
    before,
  });

  // `lastOutEventId` lets a first page seed the conversation and resume its stream after it.
  return json({
    messages: seed?.messages ?? [],
    nextCursor: seed?.nextCursor,
    lastOutEventId: seed?.lastOutEventId,
  });
}
