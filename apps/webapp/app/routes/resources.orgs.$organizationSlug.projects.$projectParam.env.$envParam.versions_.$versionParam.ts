import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { findVersion } from "~/presenters/v3/VersionPresenter.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

// One version's summary, loaded when someone opens a version label's popover.
export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema.extend({ versionParam: z.string() }),
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "deployments" } },
  },
  async ({ params, user }) => {
    const project = await findProjectBySlug(params.organizationSlug, params.projectParam, user.id);
    if (!project) throw new Response("Not Found", { status: 404 });
    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) throw new Response("Not Found", { status: 404 });

    return json({ detail: await findVersion(environment, params.versionParam) });
  }
);
