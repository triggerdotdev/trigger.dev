import { User } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";

//Only get the job ids, otherwise we're just fetching data that's already been fetched
export class IntegrationClientJobsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    clientSlug,
  }: {
    userId: User["id"];
    organizationSlug: Organization["slug"];
    projectSlug: Project["slug"];
    clientSlug: string;
  }) {
    const jobs = await this.#prismaClient.job.findMany({
      select: {
        id: true,
      },
      where: {
        internal: false,
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
        integrations: {
          some: {
            apiConnectionClient: {
              slug: clientSlug,
            },
          },
        },
      },
      orderBy: [{ title: "asc" }],
    });

    return {
      jobs: jobs.map((j) => j),
    };
  }
}
