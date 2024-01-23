import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import {
  commitCurrentProjectSession,
  getCurrentProjectId,
  setCurrentProjectId,
} from "~/services/currentProject.server";
import { ProjectPresenter } from "./ProjectPresenter.server";
import { logger } from "~/services/logger.server";
import { redirect } from "remix-typedjson";
import { projectPath } from "~/utils/pathBuilder";

type Org = Awaited<ReturnType<OrganizationsPresenter["getOrganizations"]>>[number];

export class OrganizationsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    organizationSlug,
    request,
  }: {
    userId: string;
    organizationSlug: string;
    request: Request;
  }) {
    const organizations = await this.getOrganizations(userId);

    const organization = organizations.find((o) => o.slug === organizationSlug);
    if (!organization) {
      logger.info("Not Found: organization", {
        organizationSlug,
        request,
        organization,
      });
      throw new Response("Not Found", { status: 404 });
    }

    return { organizations, organization };
  }

  async getOrganizations(userId: string) {
    const orgs = await this.#prismaClient.organization.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        title: true,
        runsEnabled: true,
        projects: {
          select: {
            id: true,
            slug: true,
            name: true,
            _count: {
              select: {
                jobs: {
                  where: {
                    internal: false,
                    deletedAt: null,
                  },
                },
                sources: {
                  where: {
                    active: false,
                  },
                },
                httpEndpoints: true,
              },
            },
          },
          orderBy: { name: "asc" },
        },
        _count: {
          select: {
            integrations: {
              where: {
                setupStatus: "MISSING_FIELDS",
              },
            },
          },
        },
      },
    });

    return orgs.map((org) => {
      return {
        id: org.id,
        slug: org.slug,
        title: org.title,
        projects: org.projects.map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          jobCount: project._count.jobs,
        })),
        hasUnconfiguredIntegrations: org._count.integrations > 0,
        runsEnabled: org.runsEnabled,
      };
    });
  }

  async selectBestProject(organizationSlug: string, userId: string) {
    const projects = await this.#prismaClient.project.findMany({
      select: {
        id: true,
        slug: true,
      },
      where: {
        organization: {
          slug: organizationSlug,
          members: { some: { userId } },
        },
      },
      orderBy: {
        jobs: {
          _count: "desc",
        },
      },
      take: 1,
    });

    if (projects.length === 0) {
      logger.info("Didn't find a project in this org", { organizationSlug, projects });
      throw new Response("Not Found", { status: 404 });
    }

    return projects[0];
  }
}
