import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { chatSnapshotStorageKey } from "~/services/realtime/chatSnapshot.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import {
  downloadTranscript,
  isTranscriptNotFound,
} from "~/services/realtime/transcriptDownload.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import {
  objectExistsInObjectStore,
  downloadObjectResponseFromObjectStore,
} from "~/v3/objectStore.server";

const ParamsSchema = EnvironmentParamSchema.extend({ sessionParam: z.string() });
const headers = { "Cache-Control": "private, no-store" };

// Cookie-auth only: saved runtime state must never be exposed to public session tokens.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, sessionParam } = ParamsSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404, headers });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return json({ error: "Environment not found" }, { status: 404, headers });
  const session = await resolveSessionByIdOrExternalId($replica, environment.id, sessionParam);
  if (!session) return json({ error: "Session not found" }, { status: 404, headers });

  try {
    const storagePath = chatSnapshotStorageKey(session);
    const packet = { dataType: "application/store", data: storagePath };
    const location = { projectRef: project.externalRef, envSlug: environment.slug };
    if (new URL(request.url).searchParams.get("check") === "1") {
      return json({ available: await objectExistsInObjectStore(packet, location) }, { headers });
    }
    const object = await downloadObjectResponseFromObjectStore(packet, location);
    return downloadTranscript(object, storagePath, (error) => {
      logger.error("Session transcript download stream failed", {
        projectId: project.id,
        environmentId: environment.id,
        sessionId: session.friendlyId,
        error,
      });
    });
  } catch (error) {
    if (isTranscriptNotFound(error)) {
      return json({ error: "No saved transcript is available." }, { status: 404, headers });
    }
    logger.error("Failed to access session transcript", {
      projectId: project.id,
      environmentId: environment.id,
      sessionId: session.friendlyId,
      error,
    });
    return json(
      {
        error: "Could not download the saved transcript. Please try again.",
      },
      { status: 502, headers }
    );
  }
}
