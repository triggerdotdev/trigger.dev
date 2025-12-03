import {
  DeploymentErrorData,
  ExternalBuildData,
  prepareDeploymentError,
} from "@trigger.dev/core/v3";
import { type RuntimeEnvironment, type WorkerDeployment } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { type User } from "~/models/user.server";
import { getUsername } from "~/utils/username";
import { processGitMetadata } from "./BranchesPresenter.server";
import { S2 } from "@s2-dev/streamstore";
import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { tryCatch } from "@trigger.dev/core";
import { logger } from "~/services/logger.server";

const S2_TOKEN_KEY_PREFIX = "s2-token:project:";

const s2TokenRedis = createRedisClient("s2-token-cache", {
  host: env.CACHE_REDIS_HOST,
  port: env.CACHE_REDIS_PORT,
  username: env.CACHE_REDIS_USERNAME,
  password: env.CACHE_REDIS_PASSWORD,
  tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
  clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
});

const s2 = env.S2_ENABLED === "1" ? new S2({ accessToken: env.S2_ACCESS_TOKEN }) : undefined;

export type ErrorData = {
  name: string;
  message: string;
  stack?: string;
  stderr?: string;
};

export class DeploymentPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    environmentSlug,
    deploymentShortCode,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    environmentSlug: RuntimeEnvironment["slug"];
    deploymentShortCode: WorkerDeployment["shortCode"];
  }) {
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
        organizationId: true,
        externalRef: true,
      },
      where: {
        slug: projectSlug,
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    const environment = await findEnvironmentBySlug(project.id, environmentSlug, userId);
    if (!environment) {
      throw new Error(`Environment not found`);
    }

    const deployment = await this.#prismaClient.workerDeployment.findFirstOrThrow({
      where: {
        projectId: project.id,
        shortCode: deploymentShortCode,
        environmentId: environment.id,
      },
      select: {
        id: true,
        shortCode: true,
        version: true,
        runtime: true,
        runtimeVersion: true,
        errorData: true,
        imageReference: true,
        imagePlatform: true,
        externalBuildData: true,
        projectId: true,
        type: true,
        environment: {
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
        status: true,
        builtAt: true,
        deployedAt: true,
        createdAt: true,
        startedAt: true,
        installedAt: true,
        canceledAt: true,
        canceledReason: true,
        git: true,
        promotions: {
          select: {
            label: true,
          },
        },
        worker: {
          select: {
            tasks: {
              select: {
                slug: true,
                filePath: true,
              },
              orderBy: {
                slug: "asc",
              },
            },
            sdkVersion: true,
            cliVersion: true,
          },
        },
        triggeredBy: {
          select: {
            id: true,
            name: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });

    const gitMetadata = processGitMetadata(deployment.git);

    const externalBuildData = deployment.externalBuildData
      ? ExternalBuildData.safeParse(deployment.externalBuildData)
      : undefined;

    let eventStream = undefined;
    if (env.S2_ENABLED === "1" && gitMetadata?.source === "trigger_github_app") {
      const [error, accessToken] = await tryCatch(this.getS2AccessToken(project.externalRef));

      if (error) {
        logger.error("Failed getting S2 access token", { error });
      } else {
        eventStream = {
          s2: {
            basin: env.S2_DEPLOYMENT_LOGS_BASIN_NAME,
            stream: `projects/${project.externalRef}/deployments/${deployment.shortCode}`,
            accessToken,
          },
        };
      }
    }

    return {
      eventStream,
      deployment: {
        id: deployment.id,
        shortCode: deployment.shortCode,
        version: deployment.version,
        status: deployment.status,
        createdAt: deployment.createdAt,
        startedAt: deployment.startedAt,
        installedAt: deployment.installedAt,
        builtAt: deployment.builtAt,
        deployedAt: deployment.deployedAt,
        canceledAt: deployment.canceledAt,
        canceledReason: deployment.canceledReason,
        tasks: deployment.worker?.tasks,
        label: deployment.promotions?.[0]?.label,
        environment: {
          id: deployment.environment.id,
          type: deployment.environment.type,
          slug: deployment.environment.slug,
          userId: deployment.environment.orgMember?.user.id,
          userName: getUsername(deployment.environment.orgMember?.user),
        },
        deployedBy: deployment.triggeredBy,
        sdkVersion: deployment.worker?.sdkVersion,
        cliVersion: deployment.worker?.cliVersion,
        runtime: deployment.runtime,
        runtimeVersion: deployment.runtimeVersion,
        imageReference: deployment.imageReference,
        imagePlatform: deployment.imagePlatform,
        externalBuildData:
          externalBuildData && externalBuildData.success ? externalBuildData.data : undefined,
        projectId: deployment.projectId,
        organizationId: project.organizationId,
        errorData: DeploymentPresenter.prepareErrorData(deployment.errorData),
        isBuilt: !!deployment.builtAt,
        type: deployment.type,
        git: gitMetadata,
      },
    };
  }

  private async getS2AccessToken(projectRef: string): Promise<string> {
    if (env.S2_ENABLED !== "1" || !s2) {
      throw new Error("Failed getting S2 access token: S2 is not enabled");
    }

    const redisKey = `${S2_TOKEN_KEY_PREFIX}${projectRef}`;
    const cachedToken = await s2TokenRedis.get(redisKey);

    if (cachedToken) {
      return cachedToken;
    }

    const { access_token: accessToken } = await s2.accessTokens.issue({
      id: `${projectRef}-${new Date().getTime()}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
      scope: {
        ops: ["read"],
        basins: {
          exact: env.S2_DEPLOYMENT_LOGS_BASIN_NAME,
        },
        streams: {
          prefix: `projects/${projectRef}/deployments/`,
        },
      },
    });

    await s2TokenRedis.setex(
      redisKey,
      59 * 60, // slightly shorter than the token validity period
      accessToken
    );

    return accessToken;
  }

  public static prepareErrorData(errorData: WorkerDeployment["errorData"]): ErrorData | undefined {
    if (!errorData) {
      return;
    }

    const deploymentError = DeploymentErrorData.safeParse(errorData);

    if (!deploymentError.success) {
      return;
    }

    return prepareDeploymentError(deploymentError.data);
  }
}
