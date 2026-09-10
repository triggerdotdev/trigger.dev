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

// GET: one earlier page of a Session's saved transcript, for the Agent view's
// "load earlier messages" control. Dashboard-auth counterpart to the public
// API's `/api/v1/sessions/:sessionId/transcript`; the presenter seeds the most
// recent page on first render and this serves the pages before it.
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

  return json({
    messages: seed?.messages ?? [],
    nextCursor: seed?.nextCursor,
  });
}
