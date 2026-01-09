import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { apiCors } from "~/utils/apiCors";
import { logger } from "~/services/logger.server";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import {
  VercelProjectIntegrationDataSchema,
} from "~/v3/vercel/vercelProjectIntegrationSchema";

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

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return apiCors(
      request,
      json({ error: "Invalid parameters" }, { status: 400 })
    );
  }

  const { organizationSlug, projectParam } = parsedParams.data;

  try {
    // Find the project
    const project = await prisma.project.findFirst({
      where: {
        slug: projectParam,
        organization: {
          slug: organizationSlug,
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
      return apiCors(
        request,
        json({ error: "Project not found" }, { status: 404 })
      );
    }

    // Get Vercel integration for the project
    const vercelService = new VercelIntegrationService();
    const integration = await vercelService.getVercelProjectIntegration(project.id);

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
          pullEnvVarsFromVercel: parsedIntegrationData.config.pullEnvVarsFromVercel,
          spawnDeploymentOnVercelEvent: parsedIntegrationData.config.spawnDeploymentOnVercelEvent,
          spawnBuildOnVercelEvent: parsedIntegrationData.config.spawnBuildOnVercelEvent,
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
  } catch (error) {
    logger.error("Failed to fetch Vercel projects", {
      error,
      organizationSlug,
      projectParam,
    });

    return apiCors(
      request,
      json({ error: "Internal server error" }, { status: 500 })
    );
  }
}

