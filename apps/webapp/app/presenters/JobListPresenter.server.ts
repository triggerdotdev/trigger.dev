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
import { projectPath } from "~/utils/pathBuilder";

export type ProjectJob = Awaited<ReturnType<JobListPresenter["call"]>>[0];

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
    projectSlug?: Project["slug"];
    organizationSlug: Organization["slug"];
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
        versions: {
          select: {
            version: true,
            eventSpecification: true,
            properties: true,
            status: true,
            triggerLink: true,
            triggerHelp: true,
            environment: {
              select: {
                type: true,
              },
            },
          },
          orderBy: [{ updatedAt: "desc" }],
          take: 1,
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
      },
      where: {
        internal: false,
        deletedAt: null,
        organization: orgWhere,
        project: projectSlug
          ? {
              slug: projectSlug,
            }
          : undefined,
        integrations: integrationsWhere,
      },
      orderBy: [{ title: "asc" }],
    });

    return jobs
      .flatMap((job) => {
        const version = job.versions.at(0);
        if (!version) {
          return [];
        }

        const eventSpecification = EventSpecificationSchema.parse(version.eventSpecification);

        const integrations = job.integrations.map((integration) => ({
          key: integration.key,
          title: integration.integration.slug,
          icon: integration.integration.definition.icon ?? integration.integration.definition.id,
          setupStatus: integration.integration.setupStatus,
        }));

        let properties: DisplayProperty[] = [];

        if (eventSpecification.properties) {
          properties = [...properties, ...eventSpecification.properties];
        }

        if (version.properties) {
          const versionProperties = z.array(DisplayPropertySchema).parse(version.properties);
          properties = [...properties, ...versionProperties];
        }

        return [
          {
            id: job.id,
            slug: job.slug,
            title: job.title,
            version: version.version,
            status: version.status,
            dynamic: job.dynamicTriggers.length > 0,
            event: {
              title: eventSpecification.title,
              icon: eventSpecification.icon,
              source: eventSpecification.source,
              link: projectSlug
                ? `${projectPath({ slug: organizationSlug }, { slug: projectSlug })}/${
                    version.triggerLink
                  }`
                : undefined,
            },
            integrations,
            hasIntegrationsRequiringAction: integrations.some(
              (i) => i.setupStatus === "MISSING_FIELDS"
            ),
            environment: version.environment,
            lastRun: job.runs.at(0),
            properties,
            projectSlug: job.project.slug,
          },
        ];
      })
      .filter(Boolean);
  }
}
