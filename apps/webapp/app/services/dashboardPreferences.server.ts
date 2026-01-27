import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { type UserFromSession } from "./session.server";

const SideMenuPreferences = z.object({
  isCollapsed: z.boolean().default(false),
  manageSectionCollapsed: z.boolean().default(false),
});

export type SideMenuPreferences = z.infer<typeof SideMenuPreferences>;

const DashboardPreferences = z.object({
  version: z.literal("1"),
  currentProjectId: z.string().optional(),
  projects: z.record(
    z.string(),
    z.object({
      currentEnvironment: z.object({ id: z.string() }),
    })
  ),
  sideMenu: SideMenuPreferences.optional(),
});

export type DashboardPreferences = z.infer<typeof DashboardPreferences>;

export function getDashboardPreferences(data?: any | null): DashboardPreferences {
  if (!data) {
    return {
      version: "1",
      projects: {},
    };
  }

  const result = DashboardPreferences.safeParse(data);
  if (!result.success) {
    logger.error("Failed to parse DashboardPreferences", { data, error: result.error });
    return {
      version: "1",
      projects: {},
    };
  }

  return result.data;
}

export async function updateCurrentProjectEnvironmentId({
  user,
  projectId,
  environmentId,
}: {
  user: UserFromSession;
  projectId: string;
  environmentId: string;
}) {
  if (user.isImpersonating) {
    return;
  }

  //only update if the existing preferences are different
  if (
    user.dashboardPreferences.currentProjectId === projectId &&
    user.dashboardPreferences.projects[projectId]?.currentEnvironment?.id === environmentId
  ) {
    return;
  }

  //ok we need to update the preferences
  const updatedPreferences: DashboardPreferences = {
    ...user.dashboardPreferences,
    currentProjectId: projectId,
    projects: {
      ...user.dashboardPreferences.projects,
      [projectId]: {
        ...user.dashboardPreferences.projects[projectId],
        currentEnvironment: { id: environmentId },
      },
    },
  };

  return prisma.user.update({
    where: {
      id: user.id,
    },
    data: {
      dashboardPreferences: updatedPreferences,
    },
  });
}

export async function clearCurrentProject({ user }: { user: UserFromSession }) {
  if (user.isImpersonating) {
    return;
  }

  const updatedPreferences: DashboardPreferences = {
    ...user.dashboardPreferences,
    currentProjectId: undefined,
  };

  return prisma.user.update({
    where: {
      id: user.id,
    },
    data: {
      dashboardPreferences: updatedPreferences,
    },
  });
}

export async function updateSideMenuPreferences({
  user,
  isCollapsed,
  manageSectionCollapsed,
}: {
  user: UserFromSession;
  isCollapsed?: boolean;
  manageSectionCollapsed?: boolean;
}) {
  if (user.isImpersonating) {
    return;
  }

  // Parse with schema to apply defaults, then overlay any new values
  const currentSideMenu = SideMenuPreferences.parse(user.dashboardPreferences.sideMenu ?? {});
  const updatedSideMenu = SideMenuPreferences.parse({
    ...currentSideMenu,
    ...(isCollapsed !== undefined && { isCollapsed }),
    ...(manageSectionCollapsed !== undefined && { manageSectionCollapsed }),
  });

  // Only update if something changed
  if (
    updatedSideMenu.isCollapsed === currentSideMenu.isCollapsed &&
    updatedSideMenu.manageSectionCollapsed === currentSideMenu.manageSectionCollapsed
  ) {
    return;
  }

  const updatedPreferences: DashboardPreferences = {
    ...user.dashboardPreferences,
    sideMenu: updatedSideMenu,
  };

  return prisma.user.update({
    where: {
      id: user.id,
    },
    data: {
      dashboardPreferences: updatedPreferences,
    },
  });
}
