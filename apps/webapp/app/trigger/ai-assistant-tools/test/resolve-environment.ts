import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import type { ToolContext } from "../types";

// Resolves the project + authenticated environment for a tool call from the
// client data slugs. Throws a friendly error the tool layer converts to text.
export async function resolveTestEnvironment(
  ctx: ToolContext
): Promise<AuthenticatedEnvironment> {
  const { findProjectBySlug } = await import("~/models/project.server");
  const { findEnvironmentBySlug } = await import("~/models/runtimeEnvironment.server");

  const project = await findProjectBySlug(
    ctx.clientData.organizationSlug,
    ctx.clientData.projectSlug,
    ctx.clientData.userId
  );
  if (!project) {
    throw new Error(`Project "${ctx.clientData.projectSlug}" not found`);
  }

  const environment = await findEnvironmentBySlug(
    project.id,
    ctx.clientData.environmentSlug,
    ctx.clientData.userId
  );
  if (!environment) {
    throw new Error(`Environment "${ctx.clientData.environmentSlug}" not found`);
  }

  return environment;
}
