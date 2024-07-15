import { type WorkerDeploymentStatus } from "@trigger.dev/database";
import { sqlDatabaseSchema, type PrismaClient, prisma } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { getUsername } from "~/utils/username";

const pageSize = 20;

export type DeploymentList = Awaited<ReturnType<DeploymentListPresenter["call"]>>;
export type DeploymentListItem = DeploymentList["deployments"][0];

export class DeploymentListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    page = 1,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    page?: number;
  }) {
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
        environments: {
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

    const totalCount = await this.#prismaClient.workerDeployment.count({
      where: {
        projectId: project.id,
      },
    });

    const labeledDeployments = await this.#prismaClient.workerDeploymentPromotion.findMany({
      where: {
        environmentId: {
          in: project.environments.map((env) => env.id),
        },
      },
      select: {
        deploymentId: true,
        label: true,
      },
    });

    const deployments = await this.#prismaClient.$queryRaw<
      {
        id: string;
        shortCode: string;
        version: string;
        status: WorkerDeploymentStatus;
        environmentId: string;
        builtAt: Date | null;
        deployedAt: Date | null;
        tasksCount: BigInt | null;
        userId: string | null;
        userName: string | null;
        userDisplayName: string | null;
        userAvatarUrl: string | null;
      }[]
    >`
    SELECT 
  wd."id", 
  wd."shortCode", 
  wd."version", 
  (SELECT COUNT(*) FROM ${sqlDatabaseSchema}."BackgroundWorkerTask" WHERE "BackgroundWorkerTask"."workerId" = wd."workerId") AS "tasksCount", 
  wd."environmentId", 
  wd."status", 
  u."id" AS "userId", 
  u."name" AS "userName", 
  u."displayName" AS "userDisplayName", 
  u."avatarUrl" AS "userAvatarUrl", 
  wd."builtAt",
  wd."deployedAt"
FROM 
  ${sqlDatabaseSchema}."WorkerDeployment" as wd
INNER JOIN 
  ${sqlDatabaseSchema}."User" as u ON wd."triggeredById" = u."id" 
WHERE 
  wd."projectId" = ${project.id}
ORDER BY 
  string_to_array(wd."version", '.')::int[] DESC 
LIMIT ${pageSize} OFFSET ${pageSize * (page - 1)};`;

    return {
      currentPage: page,
      totalPages: Math.ceil(totalCount / pageSize),
      deployments: deployments.map((deployment, index) => {
        const environment = project.environments.find((env) => env.id === deployment.environmentId);
        if (!environment) {
          throw new Error(`Environment not found for deployment ${deployment.id}`);
        }

        const label = labeledDeployments.find(
          (labeledDeployment) => labeledDeployment.deploymentId === deployment.id
        );

        return {
          id: deployment.id,
          shortCode: deployment.shortCode,
          version: deployment.version,
          status: deployment.status,
          builtAt: deployment.builtAt,
          deployedAt: deployment.deployedAt,
          tasksCount: deployment.tasksCount ? Number(deployment.tasksCount) : null,
          label: label?.label,
          isBuilt: !!deployment.builtAt,
          isCurrent: label?.label === "current",
          isDeployed: deployment.status === "DEPLOYED",
          isLatest: page === 1 && index === 0,
          environment: {
            id: environment.id,
            type: environment.type,
            slug: environment.slug,
            userId: environment.orgMember?.user.id,
            userName: getUsername(environment.orgMember?.user),
          },
          deployedBy: deployment.userId
            ? {
                id: deployment.userId,
                name: deployment.userName,
                displayName: deployment.userDisplayName,
                avatarUrl: deployment.userAvatarUrl,
              }
            : undefined,
        };
      }),
    };
  }
}
