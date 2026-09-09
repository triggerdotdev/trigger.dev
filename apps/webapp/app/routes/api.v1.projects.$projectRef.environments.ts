import { json } from "@remix-run/server-runtime";
import { type GetProjectEnvironmentsResponseBody } from "@trigger.dev/core/v3";
import { type Prisma } from "@trigger.dev/database";
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

// An org-scoped token has no environment/parent narrowing, so a project with many preview
// branches could otherwise return them all in one response. Bound it and flag the cut via header.
export const MAX_PROJECT_ENVIRONMENTS = 300;

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
    organizationScoped: true,
    authorization: { action: "read", resource: () => ({ type: "environments" }) },
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

    // An org-scoped token has no single environment to narrow to — resolveUserActorEnvironmentScope
    // answers it project-wide — so it should see the same full set (branches included) as an
    // environment-scoped caller of this project would, not the parent-only set a claimless caller gets.
    const isOrganizationScopedToken = Boolean(authentication.userActor?.organizationId);

    const select = {
      id: true,
      slug: true,
      type: true,
      isBranchableEnvironment: true,
      parentEnvironmentId: true,
      branchName: true,
      paused: true,
    } as const;
    const commonWhere: Prisma.RuntimeEnvironmentWhereInput = {
      projectId: project.id,
      archivedAt: null,
      OR: [
        { type: { in: ["STAGING", "PRODUCTION", "PREVIEW"] } },
        // dev is per-user: only return the caller's own dev environment
        { type: "DEVELOPMENT", orgMember: { userId: authentication.userId } },
      ],
    };

    let environments: Array<{
      id: string;
      slug: string;
      type: "DEVELOPMENT" | "STAGING" | "PREVIEW" | "PRODUCTION";
      isBranchableEnvironment: boolean;
      parentEnvironmentId: string | null;
      branchName: string | null;
      paused: boolean;
    }>;
    let truncated = false;

    if (scope.scoped) {
      // A scoped token lists exactly the environment it was signed for, branch child or not —
      // otherwise a token minted on a preview branch would list nothing at all.
      environments = await $replica.runtimeEnvironment.findMany({
        where: { ...commonWhere, id: scope.environmentId },
        select,
      });
    } else if (isOrganizationScopedToken) {
      // No environment/parent to narrow to, so a project with many preview branches could
      // otherwise return them all in one response. Fetch one past the cap to detect the cut,
      // ordered parents-first then branches newest-first, so a capped result keeps the most
      // relevant rows.
      const rows = await $replica.runtimeEnvironment.findMany({
        where: commonWhere,
        select,
        orderBy: [{ parentEnvironmentId: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
        take: MAX_PROJECT_ENVIRONMENTS + 1,
      });
      truncated = rows.length > MAX_PROJECT_ENVIRONMENTS;
      environments = truncated ? rows.slice(0, MAX_PROJECT_ENVIRONMENTS) : rows;
    } else {
      // Unscoped callers get base/parent environments only: syncs target the parent.
      environments = await $replica.runtimeEnvironment.findMany({
        where: { ...commonWhere, parentEnvironmentId: null },
        select,
      });
    }

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

    return json(result, truncated ? { headers: { "X-Truncated": "true" } } : undefined);
  }
);
