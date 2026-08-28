import type { RuntimeEnvironment, PrismaClient } from "@trigger.dev/database";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { type UserFromSession } from "~/services/session.server";
import { newOrganizationPath, newProjectPath } from "~/utils/pathBuilder";
import { SelectBestEnvironmentPresenter } from "./SelectBestEnvironmentPresenter.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { defaultAvatar, parseAvatar } from "~/components/primitives/Avatar";
import { globalFeatureFlags, mergeOrgFeatureFlags } from "~/v3/featureFlags.server";
import { hydrateEnvsWithActivity } from "./v3/BranchesPresenter.server";

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

    const selector = new SelectBestEnvironmentPresenter();
    const bestProject = await selector.selectBestProjectFromProjects({
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
            paused: true,
            pauseSource: true,
            isBranchableEnvironment: true,
            branchName: true,
            parentEnvironmentId: true,
            archivedAt: true,
            updatedAt: true,
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

    const environments = fullProject.environments.filter(
      (env) => env.type !== "DEVELOPMENT" || env.orgMember?.userId === user.id
    );

    const environmentsWithActivity = await hydrateEnvsWithActivity(
      user.id,
      fullProject.id,
      environments
    );

    const environment = this.#getEnvironment({
      user,
      projectId: fullProject.id,
      environments,
      environmentSlug,
    });

    return {
      organizations,
      organization,
      project: {
        ...fullProject,
        createdAt: fullProject.createdAt,
        environments: sortEnvironments(environmentsWithActivity),
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
        featureFlags: true,
        projects: {
          where: { deletedAt: null, version: "V3" },
          select: {
            id: true,
            slug: true,
            name: true,
            updatedAt: true,
            externalRef: true,
          },
          orderBy: { name: "asc" },
        },
      },
    });

    const globalFlags = await globalFeatureFlags();

    return orgs.map((org) => {
      const combinedFlags = mergeOrgFeatureFlags(globalFlags, org.featureFlags);

      return {
        id: org.id,
        slug: org.slug,
        title: org.title,
        avatar: parseAvatar(org.avatar, defaultAvatar),
        featureFlags: combinedFlags,
        projects: org.projects.map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          updatedAt: project.updatedAt,
          externalRef: project.externalRef,
        })),
      };
    });
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
    environments: (Pick<
      RuntimeEnvironment,
      | "id"
      | "slug"
      | "type"
      | "branchName"
      | "paused"
      | "pauseSource"
      | "parentEnvironmentId"
      | "isBranchableEnvironment"
      | "archivedAt"
    > & {
      orgMember: null | {
        userId: string | undefined;
      };
    })[];
  }) {
    if (environmentSlug) {
      const env = environments.find(
        (e) =>
          e.slug === environmentSlug &&
          (e.type !== "DEVELOPMENT" || e.orgMember?.userId === user.id)
      );
      if (env) {
        return env;
      }

      if (!env) {
        logger.info("Not Found: environment", {
          environmentSlug,
          environmentCount: environments.length,
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
