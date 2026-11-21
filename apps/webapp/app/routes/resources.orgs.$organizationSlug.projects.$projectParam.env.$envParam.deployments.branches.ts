import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { $replica, sqlDatabaseSchema } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { listDeploymentBranches } from "~/v3/deploymentBranches.server";

/** The deployments list's Branch filter loads its options from here when it opens. */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  return json({
    branches: await listDeploymentBranches($replica, sqlDatabaseSchema, environment.id),
  });
}
