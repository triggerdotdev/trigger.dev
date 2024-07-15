import { type DisplayProperty , DisplayPropertySchema , EventSpecificationSchema } from '@trigger.dev/core/schemas';
import { PrismaClient, Prisma, prisma, sqlDatabaseSchema } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { z } from "zod";
import { projectPath } from "~/utils/pathBuilder";
import { type JobRunStatus } from "@trigger.dev/database";
import { BasePresenter } from "./v3/basePresenter.server";

export type ProjectJob = Awaited<ReturnType<JobListPresenter["call"]>>[0];

export class JobListPresenter extends BasePresenter {
  

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

    const jobs = await this._replica.job.findMany({
      select: {
        id: true,
        slug: true,
        title: true,
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

    let latestRuns = [] as {
      createdAt: Date;
      status: JobRunStatus;
      jobId: string;
      rn: BigInt;
    }[];

    if (jobs.length > 0) {
      latestRuns = await this._replica.$queryRaw<
        {
          createdAt: Date;
          status: JobRunStatus;
          jobId: string;
          rn: BigInt;
        }[]
      >`
        SELECT * FROM (
          SELECT 
              "id", 
              "createdAt", 
              "status", 
              "jobId",
              ROW_NUMBER() OVER(PARTITION BY "jobId" ORDER BY "createdAt" DESC) as rn
          FROM 
              ${sqlDatabaseSchema}."JobRun" 
          WHERE 
              "jobId" IN (${Prisma.join(jobs.map((j) => j.id))})
      ) t
      WHERE rn = 1;`;
    }

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

        //deduplicate integrations
        const uniqueIntegrations = new Map<string, (typeof integrations)[0]>();
        integrations.forEach((i) => {
          uniqueIntegrations.set(i.key, i);
        });

        let properties: DisplayProperty[] = [];

        if (eventSpecification.properties) {
          properties = [...properties, ...eventSpecification.properties];
        }

        if (version.properties) {
          const versionProperties = z.array(DisplayPropertySchema).parse(version.properties);
          properties = [...properties, ...versionProperties];
        }

        const latestRun = latestRuns.find((r) => r.jobId === job.id);

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
            integrations: Array.from(uniqueIntegrations.values()),
            hasIntegrationsRequiringAction: integrations.some(
              (i) => i.setupStatus === "MISSING_FIELDS"
            ),
            environment: version.environment,
            lastRun: latestRun,
            properties,
            projectSlug: job.project.slug,
          },
        ];
      })
      .filter(Boolean);
  }
}
