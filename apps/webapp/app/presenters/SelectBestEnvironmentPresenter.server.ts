import {
  type RuntimeEnvironment,
  type PrismaClient,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { type UserFromSession } from "~/services/session.server";
import { selectAccessibleEnvironment } from "~/utils/environmentAccess";

export type MinimumEnvironment = Pick<RuntimeEnvironment, "id" | "type" | "slug" | "paused"> & {
  orgMember: null | {
    userId: string | undefined;
  };
};

export class SelectBestEnvironmentPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    user,
    projectRef,
    devEnvironment,
  }: {
    user: UserFromSession;
    projectRef?: string;
    devEnvironment?: boolean;
  }) {
    const { project, organization } = await this.getBestProject(user, projectRef);
    const environment = await this.selectBestEnvironment(
      project.id,
      user,
      project.environments,
      devEnvironment
    );

    return {
      project,
      organization,
      environment,
      // False when an explicit ref couldn't be reached and another project was picked instead.
      projectRefMatched: !projectRef || project.externalRef === projectRef,
    };
  }

  async getBestProject(user: UserFromSession, projectRef?: string) {
    //an explicitly requested project (e.g. a docs link for the project the reader picked), else the
    //current project from the cookie
    const projectId = projectRef ? undefined : user.dashboardPreferences.currentProjectId;

    if (projectRef || projectId) {
      const project = await this.#prismaClient.project.findFirst({
        where: {
          ...(projectRef ? { externalRef: projectRef } : { id: projectId }),
          deletedAt: null,
          organization: { members: { some: { userId: user.id } } },
        },
        include: {
          organization: true,
          environments: {
            where: { archivedAt: null },
            select: {
              id: true,
              type: true,
              slug: true,
              parentEnvironmentId: true,
              paused: true,
              orgMember: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
      });
      if (project) {
        return { project, organization: project.organization };
      }
    }

    //failing that, we pick the most recently modified project
    const projects = await this.#prismaClient.project.findMany({
      include: {
        organization: true,
        environments: {
          where: { archivedAt: null },
          select: {
            id: true,
            type: true,
            slug: true,
            parentEnvironmentId: true,
            paused: true,
            orgMember: {
              select: {
                userId: true,
              },
            },
          },
        },
      },
      where: {
        deletedAt: null,
        organization: {
          members: { some: { userId: user.id } },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 1,
    });

    if (projects.length === 0) {
      throw new Response("Not Found", { status: 404 });
    }

    return { project: projects[0], organization: projects[0].organization };
  }

  async selectBestProjectFromProjects({
    user,
    projectSlug,
    projects,
  }: {
    user: Pick<UserFromSession, "dashboardPreferences">;
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

  async selectBestEnvironment<
    T extends {
      id: string;
      type: RuntimeEnvironmentType;
      slug: string;
      parentEnvironmentId: string | null;
      orgMember: { userId: string } | null;
    },
  >(
    projectId: string,
    user: UserFromSession,
    environments: T[],
    //skip the remembered environment: the caller wants the user's own dev environment
    devEnvironment = false
  ): Promise<T> {
    //try get current environment from prefs
    const currentEnvironmentId: string | undefined = devEnvironment
      ? undefined
      : user.dashboardPreferences.projects[projectId]?.currentEnvironment.id;

    const currentEnvironment = selectAccessibleEnvironment(
      environments.filter((env) => env.id === currentEnvironmentId),
      user.id
    );
    if (currentEnvironment) {
      return currentEnvironment;
    }

    //otherwise show their dev environment
    const yourDevEnvironment = environments.find(
      // Return the default dev environment (the root, no parent), not a branch
      (env) =>
        env.type === "DEVELOPMENT" &&
        env.parentEnvironmentId === null &&
        env.orgMember?.userId === user.id
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
