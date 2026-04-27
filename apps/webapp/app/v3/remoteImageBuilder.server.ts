import { depot } from "@depot/sdk-node";
import { type ExternalBuildData } from "@trigger.dev/core/v3";
import { type Project } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import pRetry from "p-retry";
import { logger } from "~/services/logger.server";

export async function createRemoteImageBuild(
  project: Project
): Promise<ExternalBuildData | undefined> {
  if (!remoteBuildsEnabled()) {
    return;
  }

  const builderProjectId = await createBuilderProjectIfNotExists(project);

  const result = await pRetry(
    () =>
      depot.build.v1.BuildService.createBuild(
        { projectId: builderProjectId },
        {
          headers: {
            Authorization: `Bearer ${env.DEPOT_TOKEN}`,
          },
        }
      ),
    {
      retries: 3,
      minTimeout: 200,
      maxTimeout: 2000,
      onFailedAttempt: (error) => {
        logger.error("Failed attempt to create remote Depot build", { error });
      },
    }
  );

  return {
    projectId: builderProjectId,
    buildToken: result.buildToken,
    buildId: result.buildId,
  };
}

async function createBuilderProjectIfNotExists(project: Project) {
  if (project.builderProjectId) {
    return project.builderProjectId;
  }

  const result = await depot.core.v1.ProjectService.createProject(
    {
      name: `${env.APP_ENV} ${project.externalRef}`,
      organizationId: env.DEPOT_ORG_ID,
      regionId: env.DEPOT_REGION,
    },
    {
      headers: {
        Authorization: `Bearer ${env.DEPOT_TOKEN}`,
      },
    }
  );

  if (!result.project) {
    throw new Error("Failed to create builder project");
  }

  await prisma.project.update({
    where: { id: project.id },
    data: {
      builderProjectId: result.project.projectId,
    },
  });

  return result.project.projectId;
}

export function remoteBuildsEnabled() {
  return env.DEPOT_TOKEN && env.DEPOT_ORG_ID && env.DEPOT_REGION;
}
