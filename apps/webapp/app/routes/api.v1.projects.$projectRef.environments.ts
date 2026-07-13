import { json } from "@remix-run/server-runtime";
import { type GetProjectEnvironmentsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { isBranchableEnvironment } from "~/utils/branchableEnvironment";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "all",
    // Resolve projectRef → org so the PAT plugin can ground its role-floor
    // calculation. Membership is enforced by the plugin (`authenticatePat`
    // rejects users who aren't members of the target org) and again by
    // `findProjectByRef` below.
    context: async (params) => {
      const project = await $replica.project.findFirst({
        where: { externalRef: params.projectRef },
        select: { organizationId: true },
      });
      return project ? { organizationId: project.organizationId } : {};
    },
    authorization: { action: "read", resource: () => ({ type: "environments" }) },
  },
  async ({ params, authentication }) => {
    const project = await findProjectByRef(params.projectRef, authentication.userId);

    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    const environments = await $replica.runtimeEnvironment.findMany({
      where: {
        projectId: project.id,
        // Only base/parent environments. Branch children (preview branches)
        // are excluded — syncs target the parent and branches override elsewhere.
        parentEnvironmentId: null,
        archivedAt: null,
        OR: [
          { type: { in: ["STAGING", "PRODUCTION", "PREVIEW"] } },
          // dev is per-user: only return the caller's own dev environment
          { type: "DEVELOPMENT", orgMember: { userId: authentication.userId } },
        ],
      },
      select: {
        id: true,
        slug: true,
        type: true,
        isBranchableEnvironment: true,
        parentEnvironmentId: true,
        branchName: true,
        paused: true,
      },
    });

    const result: GetProjectEnvironmentsResponseBody = sortEnvironments(environments).map(
      (env) => ({
        id: env.id,
        slug: env.slug,
        type: env.type,
        isBranchableEnvironment: isBranchableEnvironment(env),
        branchName: env.branchName,
        paused: env.paused,
      })
    );

    return json(result);
  }
);
