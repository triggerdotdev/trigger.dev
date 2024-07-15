import { type User } from "@trigger.dev/database";
import { replacements } from '@trigger.dev/core/replacements';
import { type PrismaClient, prisma } from "~/db.server";
import { type Job } from "~/models/job.server";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { EventExample } from '@trigger.dev/core/schemas';

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
                integrations: {
                  select: {
                    integration: {
                      select: {
                        authSource: true,
                      },
                    },
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
            environment: {
              OR: [
                {
                  orgMember: null,
                },
                {
                  orgMember: {
                    userId,
                  },
                },
              ],
            },
          },
        },
        runs: {
          select: {
            id: true,
            createdAt: true,
            number: true,
            status: true,
            event: {
              select: {
                payload: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 5,
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
        project: {
          slug: projectSlug,
        },
        slug: jobSlug,
      },
    });

    if (!job) {
      throw new Error("Job not found");
    }

    //collect together the examples, we don't care about the environments
    const examples = job.aliases.flatMap((alias) =>
      alias.version.examples.map((example) => ({
        ...example,
        icon: example.icon ?? undefined,
        payload: example.payload ? JSON.stringify(example.payload, exampleReplacer, 2) : undefined,
      }))
    );

    return {
      environments: job.aliases.map((alias) => ({
        id: alias.environment.id,
        type: alias.environment.type,
        slug: alias.environment.slug,
        userId: alias.environment.orgMember?.userId,
        versionId: alias.version.id,
        hasAuthResolver: alias.version.integrations.some(
          (i) => i.integration.authSource === "RESOLVER"
        ),
      })),
      examples,
      runs: job.runs.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        created: r.createdAt,
        payload: r.event.payload ? JSON.stringify(r.event.payload, null, 2) : undefined,
      })),
    };
  }
}

function exampleReplacer(key: string, value: any) {
  replacements.forEach((replacement) => {
    if (value === replacement.marker) {
      value = replacement.replace({
        match: {
          key,
          value,
        },
        data: { now: new Date() },
      });
    }
  });

  return value;
}
