import {
  DisplayProperty,
  DisplayPropertySchema,
  EventSpecificationSchema,
  IntegrationMetadataSchema,
} from "@/../../packages/internal/src";
import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { z } from "zod";

export class ProjectPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    slug,
  }: Pick<Project, "slug"> & {
    userId: User["id"];
  }) {
    const project = await this.#prismaClient.project.findFirst({
      select: {
        id: true,
        slug: true,
        name: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
        jobs: {
          select: {
            id: true,
            slug: true,
            title: true,
            aliases: {
              select: {
                version: {
                  select: {
                    version: true,
                    eventSpecification: true,
                    properties: true,
                    runs: {
                      select: {
                        createdAt: true,
                        status: true,
                      },
                      take: 1,
                      orderBy: [{ createdAt: "desc" }],
                    },
                    integrations: {
                      select: {
                        metadata: true,
                      },
                    },
                  },
                },
                environment: {
                  select: {
                    type: true,
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
          },
          where: {
            internal: false,
          },
          orderBy: [{ title: "asc" }],
        },
        environments: {
          select: {
            id: true,
            slug: true,
            type: true,
            orgMember: {
              select: {
                userId: true,
              },
            },
          },
        },
      },
      where: { slug, organization: { members: { some: { userId } } } },
    });

    if (!project) {
      return undefined;
    }

    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      organizationId: project.organizationId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      jobs: project.jobs
        .map((job) => {
          //the best alias to select:
          // 1. Logged-in user dev
          // 2. Prod
          // 3. Any other user's dev
          const sortedAliases = job.aliases.sort((a, b) => {
            if (
              a.environment.type === "DEVELOPMENT" &&
              a.environment.orgMember?.userId === userId
            ) {
              return -1;
            }

            if (
              b.environment.type === "DEVELOPMENT" &&
              b.environment.orgMember?.userId === userId
            ) {
              return 1;
            }

            if (a.environment.type === "PRODUCTION") {
              return -1;
            }

            if (b.environment.type === "PRODUCTION") {
              return 1;
            }

            return 0;
          });

          const alias = sortedAliases.at(0);

          if (!alias) {
            throw new Error(
              `No aliases found for job ${job.id}, this should never happen.`
            );
          }

          const eventSpecification = EventSpecificationSchema.parse(
            alias.version.eventSpecification
          );
          const lastRun =
            alias.version.runs[0] != null ? alias.version.runs[0] : undefined;
          const integrations = z
            .array(IntegrationMetadataSchema)
            .parse(
              alias.version.integrations.map(
                (integration) => integration.metadata
              )
            );

          let properties: DisplayProperty[] = [];

          if (eventSpecification.properties) {
            properties = [...properties, ...eventSpecification.properties];
          }

          if (alias.version.properties) {
            const versionElements = z
              .array(DisplayPropertySchema)
              .parse(alias.version.properties);
            properties = [...properties, ...versionElements];
          }

          return {
            id: job.id,
            slug: job.slug,
            title: job.title,
            version: alias.version.version,
            event: {
              title: eventSpecification.title,
              icon: eventSpecification.icon,
              source: eventSpecification.source,
            },
            integrations,
            lastRun,
            properties,
          };
        })
        .filter(Boolean),
    };
  }
}
