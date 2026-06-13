import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { type PrismaReplicaClient } from "~/db.server";
import { filterOrphanedEnvironments, sortEnvironments } from "~/utils/environmentSort";

export type EnvironmentVariablesEnvironment = {
  id: string;
  type: RuntimeEnvironmentType;
  isBranchableEnvironment: boolean;
  branchName: string | null;
};

export type EnvironmentVariablesEnvironmentsResult = {
  environments: EnvironmentVariablesEnvironment[];
  hasStaging: boolean;
};

export async function loadEnvironmentVariablesEnvironments(
  prismaClient: PrismaReplicaClient,
  { userId, projectId }: { userId: string; projectId: string },
  options?: { skipProjectAccessCheck?: boolean }
): Promise<EnvironmentVariablesEnvironmentsResult> {
  if (!options?.skipProjectAccessCheck) {
    const project = await prismaClient.project.findFirst({
      select: {
        id: true,
      },
      where: {
        id: projectId,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }
  }

  const environments = await prismaClient.runtimeEnvironment.findMany({
    select: {
      id: true,
      type: true,
      isBranchableEnvironment: true,
      branchName: true,
      orgMember: {
        select: {
          userId: true,
        },
      },
    },
    where: {
      projectId,
      archivedAt: null,
    },
  });

  const sortedEnvironments = sortEnvironments(filterOrphanedEnvironments(environments)).filter(
    (environment) => environment.orgMember?.userId === userId || environment.orgMember === null
  );

  return {
    environments: sortedEnvironments.map((environment) => ({
      id: environment.id,
      type: environment.type,
      isBranchableEnvironment: environment.isBranchableEnvironment,
      branchName: environment.branchName,
    })),
    hasStaging: environments.some((environment) => environment.type === "STAGING"),
  };
}
