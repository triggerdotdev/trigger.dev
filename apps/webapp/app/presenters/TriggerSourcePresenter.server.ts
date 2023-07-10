import { TriggerSource, User } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";

export class TriggerSourcePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    triggerSourceId,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    triggerSourceId: TriggerSource["id"];
  }) {
    const trigger = await this.#prismaClient.triggerSource.findUnique({
      select: {
        id: true,
        active: true,
        integration: {
          select: {
            id: true,
            title: true,
            slug: true,
            definitionId: true,
            setupStatus: true,
          },
        },
        environment: {
          select: {
            type: true,
          },
        },
        createdAt: true,
        updatedAt: true,
        params: true,
        sourceRegistrationJob: {
          select: {
            job: {
              select: {
                id: true,
                slug: true,
              },
            },
            runs: {
              select: {
                id: true,
                number: true,
                environment: {
                  select: {
                    type: true,
                  },
                },
                status: true,
                startedAt: true,
                completedAt: true,
                createdAt: true,
                version: {
                  select: {
                    version: true,
                  },
                },
                isTest: true,
              },
              orderBy: {
                id: "desc",
              },
              take: 20,
            },
          },
        },
      },
      where: {
        id: triggerSourceId,
      },
    });

    if (!trigger) {
      throw new Error("Trigger source not found");
    }

    return {
      trigger: {
        id: trigger.id,
        active: trigger.active,
        integration: trigger.integration,
        environment: trigger.environment,
        createdAt: trigger.createdAt,
        updatedAt: trigger.updatedAt,
        params: trigger.params,
        registrationJob: trigger.sourceRegistrationJob
          ? {
              id: trigger.sourceRegistrationJob.job.id,
              slug: trigger.sourceRegistrationJob.job.slug,
              runs: trigger.sourceRegistrationJob.runs.map((r) => ({
                id: r.id,
                number: r.number,
                environment: r.environment,
                status: r.status,
                startedAt: r.startedAt,
                completedAt: r.completedAt,
                createdAt: r.createdAt,
                version: r.version.version,
                isTest: r.isTest,
              })),
            }
          : undefined,
      },
    };
  }
}
