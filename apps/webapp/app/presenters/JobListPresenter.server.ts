import {
  DisplayProperty,
  DisplayPropertySchema,
  EventSpecificationSchema,
} from "@trigger.dev/core";
import { PrismaClient, Prisma, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { z } from "zod";

export class JobListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    integrationSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug?: Organization["slug"];
    integrationSlug?: string;
  }) {
    const orgWhere: Prisma.JobWhereInput["organization"] = organizationSlug
      ? { slug: organizationSlug, members: { some: { userId } } }
      : { members: { some: { userId } } };

    const integrationsWhere: Prisma.JobWhereInput["integrations"] = integrationSlug
      ? { some: { integration: { slug: integrationSlug } } }
      : {};

    const jobs = await this.#prismaClient.job.findMany({
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
                    key: true,
                    integration: {
                      select: {
                        slug: true,
                        definition: true,
                        setupStatus: true,
                      },
                    },
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
        dynamicTriggers: {
          select: {
            type: true,
          },
        },
      },
      where: {
        internal: false,
        organization: orgWhere,
        project: {
          slug: projectSlug,
        },
        integrations: integrationsWhere,
      },
      orderBy: [{ title: "asc" }],
    });

    return jobs
      .map((job) => {
        //the best alias to select:
        // 1. Logged-in user dev
        // 2. Prod
        // 3. Any other user's dev
        const sortedAliases = job.aliases.sort((a, b) => {
          if (a.environment.type === "DEVELOPMENT" && a.environment.orgMember?.userId === userId) {
            return -1;
          }

          if (b.environment.type === "DEVELOPMENT" && b.environment.orgMember?.userId === userId) {
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
          throw new Error(`No aliases found for job ${job.id}, this should never happen.`);
        }

        const eventSpecification = EventSpecificationSchema.parse(alias.version.eventSpecification);

        const lastRuns = job.aliases
          .map((alias) => alias.version.runs.at(0))
          .filter(Boolean)
          .sort((a, b) => {
            return b.createdAt.getTime() - a.createdAt.getTime();
          });

        const lastRun = lastRuns.at(0);

        const integrations = alias.version.integrations.map((integration) => ({
          key: integration.key,
          title: integration.integration.slug,
          icon: integration.integration.definition.icon ?? integration.integration.definition.id,
          setupStatus: integration.integration.setupStatus,
        }));

        let properties: DisplayProperty[] = [];

        if (eventSpecification.properties) {
          properties = [...properties, ...eventSpecification.properties];
        }

        if (alias.version.properties) {
          const versionProperties = z.array(DisplayPropertySchema).parse(alias.version.properties);
          properties = [...properties, ...versionProperties];
        }

        return {
          id: job.id,
          slug: job.slug,
          title: job.title,
          version: alias.version.version,
          dynamic: job.dynamicTriggers.length > 0,
          event: {
            title: eventSpecification.title,
            icon: eventSpecification.icon,
            source: eventSpecification.source,
          },
          integrations,
          hasIntegrationsRequiringAction: integrations.some(
            (i) => i.setupStatus === "MISSING_FIELDS"
          ),
          lastRun,
          properties,
        };
      })
      .filter(Boolean);
  }
}
