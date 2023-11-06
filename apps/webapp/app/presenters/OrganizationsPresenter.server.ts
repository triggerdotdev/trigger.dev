import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { getCurrentProjectId } from "~/services/currentProject.server";
import { ProjectPresenter } from "./ProjectPresenter.server";

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
    projectSlug,
  }: {
    userId: string;
    organizationSlug: string;
    request: Request;
    projectSlug?: string;
  }) {
    const organizations = await this.getOrganizations(userId);

    const organization = organizations.find((o) => o.slug === organizationSlug);
    if (!organization) {
      throw new Response("Not Found", { status: 404 });
    }

    const project = await this.getProject(organization, projectSlug, request, userId);

    return { organizations, organization, project };
  }

  async getOrganizations(userId: string) {
    const orgs = await this.#prismaClient.organization.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: "desc" },
      include: {
        projects: {
          orderBy: { name: "asc" },
          include: {
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
        },
        _count: {
          select: {
            members: true,
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
        memberCount: org._count.members,
      };
    });
  }

  async getProject(
    organization: Org,
    projectSlug: string | undefined,
    request: Request,
    userId: string
  ) {
    const projectPresenter = new ProjectPresenter();

    if (!projectSlug) {
      const projectId = await getCurrentProjectId(request);
      const orgProject = organization.projects.find((p) => p.id === projectId);
      if (!orgProject) {
        throw new Response("Not Found", { status: 404 });
      }
      projectSlug = orgProject.slug;
    }

    const project = await projectPresenter.call({ userId, slug: projectSlug });
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }
    return project;
  }
}
