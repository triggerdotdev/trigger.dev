import { PrismaClient } from "@trigger.dev/database";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import {
  commitCurrentProjectSession,
  getCurrentProjectId,
  setCurrentProjectId,
} from "~/services/currentProject.server";
import { logger } from "~/services/logger.server";
import { newProjectPath } from "~/utils/pathBuilder";
import { ProjectPresenter } from "./ProjectPresenter.server";

export class OrganizationsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    request,
  }: {
    userId: string;
    organizationSlug: string;
    projectSlug: string | undefined;
    request: Request;
  }) {
    //first get the project id, this redirects if there's no session
    const projectId = await this.#getProjectId({
      request,
      projectSlug,
      organizationSlug,
      userId,
    });

    const organizations = await this.#getOrganizations(userId);
    const organization = organizations.find((o) => o.slug === organizationSlug);
    if (!organization) {
      logger.info("Not Found: organization", {
        organizationSlug,
        request,
        organization,
      });
      throw new Response("Not Found", { status: 404 });
    }

    const projectPresenter = new ProjectPresenter(this.#prismaClient);
    const project = await projectPresenter.call({
      id: projectId,
      userId,
    });

    if (!project) {
      throw new Response("Project not found", { status: 404 });
    }

    return { organizations, organization, project };
  }

  async #getProjectId({
    request,
    projectSlug,
    organizationSlug,
    userId,
  }: {
    request: Request;
    projectSlug: string | undefined;
    organizationSlug: string;
    userId: string;
  }): Promise<string> {
    const sessionProjectId = await getCurrentProjectId(request);

    //no project in session, let's set one
    if (!sessionProjectId) {
      if (!projectSlug) {
        const bestProject = await this.#selectBestProjectForOrganization(organizationSlug, userId);
        const session = await setCurrentProjectId(bestProject.id, request);
        throw redirect(request.url, {
          headers: { "Set-Cookie": await commitCurrentProjectSession(session) },
        });
      }

      //use the project param to find the project
      const project = await prisma.project.findFirst({
        select: {
          id: true,
          slug: true,
        },
        where: {
          organization: {
            slug: organizationSlug,
          },
          slug: projectSlug,
        },
      });

      if (!project) {
        throw redirect(newProjectPath({ slug: organizationSlug }));
      }

      const session = await setCurrentProjectId(project.id, request);
      throw redirect(request.url, {
        headers: { "Set-Cookie": await commitCurrentProjectSession(session) },
      });
    }

    //no project slug, so just return the session id
    if (!projectSlug) {
      return sessionProjectId;
    }

    //check session id matches the project slug
    const project = await prisma.project.findFirst({
      select: {
        id: true,
        slug: true,
      },
      where: {
        slug: projectSlug,
        organization: {
          slug: organizationSlug,
        },
      },
    });

    if (!project) {
      throw new Response("Project not found in organization", { status: 404 });
    }

    if (project.id !== sessionProjectId) {
      const session = await setCurrentProjectId(project.id, request);
      throw redirect(request.url, {
        headers: { "Set-Cookie": await commitCurrentProjectSession(session) },
      });
    }

    return project.id;
  }

  async #getOrganizations(userId: string) {
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

  async #selectBestProjectForOrganization(organizationSlug: string, userId: string) {
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
