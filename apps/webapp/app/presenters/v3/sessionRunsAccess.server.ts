import type { PrismaClientOrTransaction, Session } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { canAccessSessionTrace } from "~/v3/canAccessSessionTrace.server";

export type SessionRunsAccess =
  | { ok: true; session: Session }
  | {
      ok: false;
      error: "Project not found" | "Not found" | "Environment not found" | "Session not found";
    };

/** The session behind a session runs request, if the user may see its runs. */
export async function findSessionForRunsView(options: {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  sessionParam: string;
  userId: string;
  isAdmin: boolean;
  isManagedCloud: boolean;
  db?: PrismaClientOrTransaction;
}): Promise<SessionRunsAccess> {
  const db = options.db ?? $replica;

  const project = await findProjectWithOrgFlagsBySlug(
    options.organizationSlug,
    options.projectSlug,
    options.userId,
    db
  );
  if (!project) return { ok: false, error: "Project not found" };

  const hasAccess = await canAccessSessionTrace({
    isManagedCloud: options.isManagedCloud,
    isAdmin: options.isAdmin,
    orgFeatureFlags: project.organization.featureFlags,
    db: options.db,
  });
  if (!hasAccess) return { ok: false, error: "Not found" };

  const environment = await findEnvironmentBySlug(
    project.id,
    options.environmentSlug,
    options.userId,
    db
  );
  if (!environment) return { ok: false, error: "Environment not found" };

  const session = await resolveSessionByIdOrExternalId(db, environment.id, options.sessionParam);
  if (!session) return { ok: false, error: "Session not found" };

  return { ok: true, session };
}
