import { resolveDeployNowAuthScope } from "~/services/deployNowAuthScope.server";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { deploymentOnboardingEnabled } from "~/v3/services/deploymentOnboardingEnabled.server";
import { BranchTrackingConfigSchema, getTrackedBranchForEnvironment } from "~/v3/github";
import { TriggerDeployNowService } from "~/v3/services/triggerDeployNow.server";

export function deployNowPath(
  organizationSlug: string,
  projectSlug: string,
  environmentSlug: string
) {
  return `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/deploy-now`;
}

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveDeployNowAuthScope(params),
    authorization: { action: "write", resource: { type: "deployments" } },
  },
  async ({ params, user }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;

    // Tenant floor: membership-scoped project lookup (see AGENTS.md tenancy rule).
    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    if (!project) {
      return json({ ok: false, error: "Not found" }, { status: 404 });
    }
    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) {
      return json({ ok: false, error: "Not found" }, { status: 404 });
    }

    // Feature-flag gate: the button is hidden when off, but the action is the
    // real security boundary.
    if (!(await deploymentOnboardingEnabled(project.organizationId))) {
      return json({ ok: false, error: "Not available" }, { status: 403 });
    }

    // Resolve the tracked branch for this environment.
    const connectedRepo = await prisma.connectedGithubRepository.findFirst({
      where: { projectId: project.id },
      select: { branchTracking: true, previewDeploymentsEnabled: true },
    });
    const branchTracking = connectedRepo
      ? BranchTrackingConfigSchema.safeParse(connectedRepo.branchTracking)
      : undefined;
    const branch =
      branchTracking?.success && connectedRepo
        ? getTrackedBranchForEnvironment(
            branchTracking.data,
            connectedRepo.previewDeploymentsEnabled,
            {
              type: environment.type,
              branchName: environment.branchName ?? undefined,
            }
          )
        : undefined;

    if (!branch) {
      return json({ ok: false, error: "No tracked branch for this environment" }, { status: 400 });
    }

    const service = new TriggerDeployNowService();
    const result = await service.call({
      projectId: project.id,
      environmentId: environment.id,
      environmentType: environment.type,
      branch,
    });

    if (!result.ok) {
      if (result.reason === "atomicProduction") {
        return json(
          {
            ok: false,
            code: "ATOMIC_PRODUCTION_REQUIRES_VERCEL",
            error:
              "This project releases its app and tasks together through Vercel. Start the deployment in Vercel.",
            vercelUrl: result.vercelUrl,
          },
          { status: 409 }
        );
      }
      if (result.reason === "error") {
        logger.error("Deploy now failed", {
          projectId: project.id,
          environmentId: environment.id,
        });
        return json({ ok: false, error: "Couldn't start the deploy" }, { status: 500 });
      }

      if (result.reason === "unsupportedEnvironment") {
        return json(
          { ok: false, error: "This environment doesn't support deploy now" },
          { status: 400 }
        );
      }

      // alreadyInFlight — a deploy is already running, which is success from the UI's
      // perspective (nothing to do, the button just shouldn't have been clickable).
    }

    return json({ ok: true });
  }
);
