import { type PrismaClient } from "@trigger.dev/database";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { type UserFromSession } from "~/services/session.server";
import { newOrganizationPath, newProjectPath } from "~/utils/pathBuilder";
import { type MinimumEnvironment } from "./SelectBestEnvironmentPresenter.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { defaultAvatarIcon, parseAvatar } from "~/components/primitives/Avatar";

export class OrganizationsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    user,
    organizationSlug,
    projectSlug,
    environmentSlug,
    request,
  }: {
    user: UserFromSession;
    organizationSlug: string;
    projectSlug: string | undefined;
    environmentSlug: string | undefined;
    request: Request;
  }) {
    const organizations = await this.#getOrganizations(user.id);
    if (organizations.length === 0) {
      logger.info("No organizations", {
        organizationSlug,
        request,
      });
      throw redirect(newOrganizationPath());
    }

    const organization = organizations.find((o) => o.slug === organizationSlug);
    if (!organization) {
      logger.info("Not Found: organization", {
        organizationSlug,
        request,
        organization,
      });
      throw new Response("Organization not Found", { status: 404 });
    }

    const bestProject = this.#getProject({
      user,
      projectSlug,
      projects: organization.projects,
    });
    if (!bestProject) {
      logger.info("Not Found: project", {
        projectSlug,
        request,
        project: bestProject,
      });
      throw redirect(newProjectPath(organization));
    }

    const fullProject = await this.#prismaClient.project.findFirst({
      where: {
        id: bestProject.id,
      },
      include: {
        environments: {
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
    });

    if (!fullProject) {
      logger.info("Not Found: project", {
        projectSlug,
        request,
        project: bestProject,
      });
      throw redirect(newProjectPath(organization));
    }

    const environment = this.#getEnvironment({
      user,
      projectId: fullProject.id,
      environments: fullProject.environments,
      environmentSlug,
    });

    return {
      organizations,
      organization,
      project: {
        ...fullProject,
        environments: sortEnvironments(
          fullProject.environments.filter((env) => {
            if (env.type !== "DEVELOPMENT") return true;
            if (env.orgMember?.userId === user.id) return true;
            return false;
          })
        ),
      },
      environment,
    };
  }

  async #getOrganizations(userId: string) {
    const orgs = await this.#prismaClient.organization.findMany({
      where: { members: { some: { userId } }, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        title: true,
        avatar: true,
        projects: {
          where: { deletedAt: null, version: "V3" },
          select: {
            id: true,
            slug: true,
            name: true,
            updatedAt: true,
          },
          orderBy: { name: "asc" },
        },
        _count: {
          select: {
            members: true,
          },
        },
      },
    });

    return orgs.map((org) => {
      return {
        id: org.id,
        slug: org.slug,
        title: org.title,
        avatar: parseAvatar(org.avatar, defaultAvatarIcon),
        projects: org.projects.map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          updatedAt: project.updatedAt,
        })),
        membersCount: org._count.members,
      };
    });
  }

  #getProject({
    user,
    projectSlug,
    projects,
  }: {
    user: UserFromSession;
    projectSlug: string | undefined;
    projects: {
      id: string;
      slug: string;
      name: string;
      updatedAt: Date;
    }[];
  }) {
    if (projectSlug) {
      const proj = projects.find((p) => p.slug === projectSlug);
      if (proj) {
        return proj;
      }

      if (!proj) {
        logger.info("Not Found: project", {
          projectSlug,
          projects,
        });
      }
    }

    const currentProjectId = user.dashboardPreferences.currentProjectId;
    const project = projects.find((p) => p.id === currentProjectId);
    if (project) {
      return project;
    }

    //most recently updated
    return projects.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).at(0);
  }

  #getEnvironment({
    user,
    projectId,
    environmentSlug,
    environments,
  }: {
    user: UserFromSession;
    projectId: string;
    environmentSlug: string | undefined;
    environments: MinimumEnvironment[];
  }) {
    if (environmentSlug) {
      const env = environments.find((e) => e.slug === environmentSlug);
      if (env) {
        return env;
      }

      if (!env) {
        logger.info("Not Found: environment", {
          environmentSlug,
          environments,
        });
      }
    }

    const currentEnvironmentId: string | undefined =
      user.dashboardPreferences.projects[projectId]?.currentEnvironment.id;

    const environment = environments.find((e) => e.id === currentEnvironmentId);
    if (environment) {
      return environment;
    }

    //otherwise show their dev environment
    const yourDevEnvironment = environments.find(
      (env) => env.type === "DEVELOPMENT" && env.orgMember?.userId === user.id
    );
    if (yourDevEnvironment) {
      return yourDevEnvironment;
    }

    //otherwise show their prod environment
    const prodEnvironment = environments.find((env) => env.type === "PRODUCTION");
    if (prodEnvironment) {
      return prodEnvironment;
    }

    throw new Error("No environments found");
  }
}
