import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { type UserFromSession } from "./session.server";

const SideMenuPreferences = z.object({
  isCollapsed: z.boolean().default(false),
  // Map for section collapsed states - keys are section identifiers
  collapsedSections: z.record(z.string(), z.boolean()).optional(),
  /** Organization-specific settings */
  organizations: z
    .record(
      z.string(),
      z.object({
        orderedItems: z.record(z.string(), z.array(z.string())),
      })
    )
    .optional(),
});

export type SideMenuPreferences = z.infer<typeof SideMenuPreferences>;

import { type SideMenuSectionId } from "~/components/navigation/sideMenuTypes";
export type { SideMenuSectionId };

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
  sectionCollapsed,
}: {
  user: UserFromSession;
  isCollapsed?: boolean;
  /** Update a specific section's collapsed state */
  sectionCollapsed?: { sectionId: SideMenuSectionId; collapsed: boolean };
}) {
  if (user.isImpersonating) {
    return;
  }

  // Parse with schema to apply defaults, then overlay any new values
  const currentSideMenu = SideMenuPreferences.parse(user.dashboardPreferences.sideMenu ?? {});

  // Build the updated collapsedSections map
  let updatedCollapsedSections = { ...currentSideMenu.collapsedSections };

  if (sectionCollapsed) {
    updatedCollapsedSections[sectionCollapsed.sectionId] = sectionCollapsed.collapsed;
  }

  const updatedSideMenu = SideMenuPreferences.parse({
    ...currentSideMenu,
    ...(isCollapsed !== undefined && { isCollapsed }),
    collapsedSections: updatedCollapsedSections,
  });

  // Only update if something changed
  const hasCollapsedSectionsChanged =
    JSON.stringify(updatedSideMenu.collapsedSections) !==
    JSON.stringify(currentSideMenu.collapsedSections);

  if (updatedSideMenu.isCollapsed === currentSideMenu.isCollapsed && !hasCollapsedSectionsChanged) {
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

/** Get the stored item order for a specific list within an organization */
export function getItemOrder(
  sideMenu: SideMenuPreferences | undefined,
  organizationId: string,
  listId: string
): string[] | undefined {
  return sideMenu?.organizations?.[organizationId]?.orderedItems?.[listId];
}

export async function updateItemOrder({
  user,
  organizationId,
  listId,
  order,
}: {
  user: UserFromSession;
  organizationId: string;
  listId: string;
  order: string[];
}) {
  if (user.isImpersonating) {
    return;
  }

  const currentSideMenu = SideMenuPreferences.parse(user.dashboardPreferences.sideMenu ?? {});
  const currentOrg = currentSideMenu.organizations?.[organizationId];

  const updatedSideMenu = SideMenuPreferences.parse({
    ...currentSideMenu,
    organizations: {
      ...currentSideMenu.organizations,
      [organizationId]: {
        ...currentOrg,
        orderedItems: {
          ...currentOrg?.orderedItems,
          [listId]: order,
        },
      },
    },
  });

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
