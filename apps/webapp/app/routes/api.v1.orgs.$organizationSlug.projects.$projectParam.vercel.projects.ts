import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { fromPromise } from "neverthrow";
import { z } from "zod";
import { prisma } from "~/db.server";
import { apiCors } from "~/utils/apiCors";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";

const ParamsSchema = z.object({
  organizationSlug: z.string(),
  projectParam: z.string(),
});

/**
 * API endpoint to retrieve connected Vercel projects for a Trigger.dev project.
 *
 * GET /api/v1/orgs/:organizationSlug/projects/:projectParam/vercel/projects
 *
 * Returns:
 * - vercelProject: The connected Vercel project details (if any)
 * - config: The Vercel integration configuration
 * - syncEnvVarsMapping: The environment variable sync mapping
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  // Handle CORS
  if (request.method === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return apiCors(
      request,
      json({ error: "Invalid or Missing Access Token" }, { status: 401 })
    );
  }

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return apiCors(
      request,
      json({ error: "Invalid parameters" }, { status: 400 })
    );
  }

  const { organizationSlug, projectParam } = parsedParams.data;

  const result = await fromPromise(
    (async () => {
      // Find the project, verifying org membership
      const project = await prisma.project.findFirst({
        where: {
          slug: projectParam,
          organization: {
            slug: organizationSlug,
            members: {
              some: {
                userId: authenticationResult.userId,
              },
            },
          },
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          organizationId: true,
        },
      });

      if (!project) {
        return { type: "not_found" as const };
      }

      // Get Vercel integration for the project
      const vercelService = new VercelIntegrationService();
      const integration = await vercelService.getVercelProjectIntegration(project.id);

      return { type: "success" as const, project, integration };
    })(),
    (error) => error
  );

  if (result.isErr()) {
    logger.error("Failed to fetch Vercel projects", {
      error: result.error,
      organizationSlug,
      projectParam,
    });

    return apiCors(
      request,
      json({ error: "Internal server error" }, { status: 500 })
    );
  }

  if (result.value.type === "not_found") {
    return apiCors(
      request,
      json({ error: "Project not found" }, { status: 404 })
    );
  }

  const { project, integration } = result.value;

  if (!integration) {
    return apiCors(
      request,
      json({
        connected: false,
        vercelProject: null,
        config: null,
        syncEnvVarsMapping: null,
      })
    );
  }

  const { parsedIntegrationData } = integration;

  return apiCors(
    request,
    json({
      connected: true,
      vercelProject: {
        id: parsedIntegrationData.vercelProjectId,
        name: parsedIntegrationData.vercelProjectName,
        teamId: parsedIntegrationData.vercelTeamId,
      },
      config: {
        atomicBuilds: parsedIntegrationData.config.atomicBuilds,
        pullEnvVarsBeforeBuild: parsedIntegrationData.config.pullEnvVarsBeforeBuild,
        vercelStagingEnvironment: parsedIntegrationData.config.vercelStagingEnvironment,
      },
      syncEnvVarsMapping: parsedIntegrationData.syncEnvVarsMapping,
      triggerProject: {
        id: project.id,
        name: project.name,
        slug: project.slug,
      },
    })
  );
}

