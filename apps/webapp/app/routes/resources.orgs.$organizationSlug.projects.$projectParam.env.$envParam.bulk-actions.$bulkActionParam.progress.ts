import { tryCatch } from "@trigger.dev/core";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { BulkActionPresenter } from "~/presenters/v3/BulkActionPresenter.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const ParamsSchema = EnvironmentParamSchema.extend({
  bulkActionParam: z.string(),
});

// A bulk action's status and counts, polled by its page while it runs. The page's own loader
// (the runs list, the failed runs) runs once and again when the action finishes.
export const loader = dashboardLoader(
  {
    params: ParamsSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "runs" } },
  },
  async ({ params, user }) => {
    const { organizationSlug, projectParam, envParam, bulkActionParam } = params;

    const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    // A failed tick keeps what the page has: an error here would replace the page.
    const [error, progress] = await tryCatch(
      new BulkActionPresenter().progress({
        environmentId: environment.id,
        bulkActionId: bulkActionParam,
      })
    );
    if (error) {
      logger.error("Failed to load bulk action progress", { error, bulkActionParam });
    }

    return typedjson({ progress: progress ?? null });
  }
);
