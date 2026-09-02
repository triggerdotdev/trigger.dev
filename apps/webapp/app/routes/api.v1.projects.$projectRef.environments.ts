import { json } from "@remix-run/server-runtime";
import { type GetProjectEnvironmentsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveUserActorEnvironmentScope } from "~/services/userActorEnvironment.server";
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
    // An org-wide delegated token lists any project of its org, so the agent can sweep
    // sibling projects. The org binding is the context above; membership is `findProjectByRef`.
    organizationScoped: true,
  },
  async ({ params, authentication }) => {
    const project = await findProjectByRef(params.projectRef, authentication.userId);

    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    // A delegated token signed for one environment only ever lists that one.
    const scope = await resolveUserActorEnvironmentScope(
      authentication.userActor,
      { projectId: project.id },
      { organizationScoped: true }
    );

    const environments = await $replica.runtimeEnvironment.findMany({
      where: {
        projectId: project.id,
        // A scoped token lists exactly the environment it was signed for, branch child or not —
        // otherwise a token minted on a preview branch would list nothing at all. Unscoped
        // callers get base/parent environments only: syncs target the parent.
        ...(scope.scoped ? { id: scope.environmentId } : { parentEnvironmentId: null }),
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
