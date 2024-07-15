import { type DisplayProperty , DisplayPropertySchema , EventSpecificationSchema , TriggerHelpSchema } from '@trigger.dev/core/schemas';
import { PrismaClient, type Prisma, prisma } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { z } from "zod";
import { projectPath } from "~/utils/pathBuilder";
import { type Job } from "@trigger.dev/database";
import { BasePresenter } from "./v3/basePresenter.server";

export class JobPresenter extends BasePresenter {
  

  public async call({
    userId,
    jobSlug,
    projectSlug,
    organizationSlug,
  }: {
    userId: User["id"];
    jobSlug: Job["slug"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
  }) {
    const job = await this._replica.job.findFirst({
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
                status: true,
                concurrencyLimit: true,
                concurrencyLimitGroup: {
                  select: {
                    name: true,
                    concurrencyLimit: true,
                  },
                },
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
                triggerLink: true,
                triggerHelp: true,
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
        project: {
          select: {
            slug: true,
          },
        },
        _count: {
          select: {
            runs: {
              where: {
                isTest: false,
              },
            },
          },
        },
      },
      where: {
        slug: jobSlug,
        deletedAt: null,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
        project: {
          slug: projectSlug,
        },
      },
    });

    if (!job) {
      return undefined;
    }

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

    const environments = job.aliases.map((alias) => ({
      type: alias.environment.type,
      enabled: alias.version.status === "ACTIVE",
      lastRun: alias.version.runs.at(0)?.createdAt,
      version: alias.version.version,
      concurrencyLimit: alias.version.concurrencyLimit,
      concurrencyLimitGroup: alias.version.concurrencyLimitGroup,
    }));

    const projectRootPath = projectPath({ slug: organizationSlug }, { slug: projectSlug });

    //we exclude test runs from this count
    const hasRealRuns = job._count.runs > 0;

    return {
      id: job.id,
      slug: job.slug,
      title: job.title,
      version: alias.version.version,
      status: alias.version.status,
      dynamic: job.dynamicTriggers.length > 0,
      event: {
        title: eventSpecification.title,
        icon: eventSpecification.icon,
        source: eventSpecification.source,
        link: alias.version.triggerLink
          ? `${projectRootPath}/${alias.version.triggerLink}`
          : undefined,
      },
      noRunsHelp: hasRealRuns
        ? undefined
        : this.#getNoRunsHelp(alias.version.triggerHelp, projectRootPath),
      integrations,
      hasIntegrationsRequiringAction: integrations.some((i) => i.setupStatus === "MISSING_FIELDS"),
      lastRun,
      properties,
      environments,
    };
  }

  #getNoRunsHelp(data: Prisma.JsonValue, projectPath: string) {
    const triggerHelp = TriggerHelpSchema.nullish().parse(data);
    if (!triggerHelp) {
      return undefined;
    }

    if (triggerHelp.noRuns) {
      triggerHelp.noRuns.link = triggerHelp.noRuns.link
        ? `${projectPath}/${triggerHelp.noRuns.link}`
        : undefined;

      return triggerHelp.noRuns;
    }
  }
}
