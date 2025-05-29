import { depot } from "@depot/sdk-node";
import { Project } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";

export async function createRemoteImageBuild(project: Project) {
  if (!remoteBuildsEnabled()) {
    return;
  }

  const builderProjectId = await createBuilderProjectIfNotExists(project);

  const result = await depot.build.v1.BuildService.createBuild(
    { projectId: builderProjectId },
    {
      headers: {
        Authorization: `Bearer ${env.DEPOT_TOKEN}`,
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
  return env.DEPOT_TOKEN && env.DEPOT_PROJECT_ID && env.DEPOT_ORG_ID && env.DEPOT_REGION;
}
