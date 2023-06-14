import { User } from ".prisma/client";
import { PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { Job } from "~/models/job.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import {
  ConnectionMetadataSchema,
  OAuthClientSchema,
} from "~/services/externalApis/types";
import { getSecretStore } from "~/services/secrets/secretStore.server";

export class TestJobPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    jobSlug,
  }: {
    userId: User["id"];
    organizationSlug: Organization["slug"];
    projectSlug: Project["slug"];
    jobSlug: Job["slug"];
  }) {
    const job = await this.#prismaClient.job.findFirst({
      select: {
        aliases: {
          select: {
            version: {
              select: {
                id: true,
                version: true,
                examples: {
                  select: {
                    id: true,
                    name: true,
                    icon: true,
                    payload: true,
                  },
                },
              },
            },
            environment: {
              select: {
                id: true,
                type: true,
                slug: true,
                orgMember: {
                  select: {
                    userId: true,
                  },
                },
              },
            },
          },
          where: {
            name: "latest",
          },
        },
        _count: {
          select: {
            runs: {
              where: {
                isTest: true,
              },
            },
          },
        },
      },
      where: {
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
        slug: jobSlug,
      },
    });

    if (!job) {
      throw new Error("Job not found");
    }

    return {
      environments: job.aliases.map((alias) => ({
        id: alias.environment.id,
        type: alias.environment.type,
        slug: alias.environment.slug,
        userId: alias.environment.orgMember?.userId,
        versionId: alias.version.id,
        examples: alias.version.examples.map((example) => ({
          ...example,
          payload: JSON.stringify(example.payload, null, 2),
        })),
      })),
      hasTestRuns: job._count.runs > 0,
    };
  }
}
