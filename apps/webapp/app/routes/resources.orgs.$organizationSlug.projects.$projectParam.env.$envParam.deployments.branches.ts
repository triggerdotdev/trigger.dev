import { json } from "@remix-run/server-runtime";
import { $replica, sqlDatabaseSchema } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { listDeploymentBranches } from "~/v3/deploymentBranches.server";

/** The deployments list's Branch filter loads its options from here when it opens. */
export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "deployments" } },
  },
  async ({ params, user }) => {
    const project = await findProjectBySlug(params.organizationSlug, params.projectParam, user.id);
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) {
      throw new Response(undefined, { status: 404, statusText: "Environment not found" });
    }

    return json({
      branches: await listDeploymentBranches($replica, sqlDatabaseSchema, environment.id),
    });
  }
);
