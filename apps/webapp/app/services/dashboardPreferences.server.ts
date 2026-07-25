import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { type UserFromSession } from "./session.server";

const FavoritePage = z.object({
  /** Stable id, generated client-side when the page is favorited. */
  id: z.string(),
  /** App-relative URL including any search params (filters, tabs). */
  url: z.string(),
  /** Display label shown in the side menu; user-renamable. */
  label: z.string(),
  /** Key into the favorite page icon registry. */
  icon: z.string().optional(),
});

export type FavoritePage = z.infer<typeof FavoritePage>;

const SideMenuPreferences = z.object({
  isCollapsed: z.boolean().default(false),
  /** Expanded side menu width in px, set by the resize handle. */
  width: z.number().optional(),
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
  /** Pages the user favorited, in display order. */
  favorites: z.array(FavoritePage).optional(),
  /** Custom top-to-bottom order of side menu sections (section ids). */
  sectionOrder: z.array(z.string()).optional(),
  /** Per-item visibility overrides (item id -> hidden). Items absent fall back to their default. */
  hiddenItems: z.record(z.string(), z.boolean()).optional(),
  /** Custom item order within a section (section id -> item ids). */
  sectionItemOrder: z.record(z.string(), z.array(z.string())).optional(),
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
  width,
  sectionCollapsed,
}: {
  user: UserFromSession;
  isCollapsed?: boolean;
  /** Expanded side menu width in px (from the resize handle) */
  width?: number;
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
    ...(width !== undefined && { width }),
    collapsedSections: updatedCollapsedSections,
  });

  // Only update if something changed
  const hasCollapsedSectionsChanged =
    JSON.stringify(updatedSideMenu.collapsedSections) !==
    JSON.stringify(currentSideMenu.collapsedSections);

  if (
    updatedSideMenu.isCollapsed === currentSideMenu.isCollapsed &&
    updatedSideMenu.width === currentSideMenu.width &&
    !hasCollapsedSectionsChanged
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

/** The most favorites a user can save; a sanity cap, not a product limit. */
const MAX_FAVORITES = 50;

async function saveSideMenu(user: UserFromSession, sideMenu: SideMenuPreferences) {
  const updatedPreferences: DashboardPreferences = {
    ...user.dashboardPreferences,
    sideMenu,
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

export async function addFavorite({
  user,
  favorite,
}: {
  user: UserFromSession;
  favorite: FavoritePage;
}) {
  if (user.isImpersonating) {
    return;
  }

  const currentSideMenu = SideMenuPreferences.parse(user.dashboardPreferences.sideMenu ?? {});
  const favorites = currentSideMenu.favorites ?? [];

  // The star is a toggle keyed on the exact URL, so an existing entry means we're already done
  if (favorites.some((f) => f.url === favorite.url)) {
    return;
  }

  if (favorites.length >= MAX_FAVORITES) {
    return;
  }

  return saveSideMenu(user, { ...currentSideMenu, favorites: [...favorites, favorite] });
}

export async function removeFavorite({ user, id }: { user: UserFromSession; id: string }) {
  if (user.isImpersonating) {
    return;
  }

  const currentSideMenu = SideMenuPreferences.parse(user.dashboardPreferences.sideMenu ?? {});
  const favorites = currentSideMenu.favorites ?? [];
  const remaining = favorites.filter((f) => f.id !== id);

  if (remaining.length === favorites.length) {
    return;
  }

  return saveSideMenu(user, {
    ...currentSideMenu,
    favorites: remaining.length > 0 ? remaining : undefined,
  });
}

export async function renameFavorite({
  user,
  id,
  label,
}: {
  user: UserFromSession;
  id: string;
  label: string;
}) {
  if (user.isImpersonating) {
    return;
  }

  const currentSideMenu = SideMenuPreferences.parse(user.dashboardPreferences.sideMenu ?? {});
  const favorites = currentSideMenu.favorites ?? [];

  const favorite = favorites.find((f) => f.id === id);
  if (!favorite || favorite.label === label) {
    return;
  }

  return saveSideMenu(user, {
    ...currentSideMenu,
    favorites: favorites.map((f) => (f.id === id ? { ...f, label } : f)),
  });
}

export async function updateSideMenuCustomization({
  user,
  sectionOrder,
  hiddenItems,
  sectionItemOrder,
  favorites,
}: {
  user: UserFromSession;
  /** undefined = leave unchanged, null = reset to default */
  sectionOrder?: string[] | null;
  /** undefined = leave unchanged, null = reset to default */
  hiddenItems?: Record<string, boolean> | null;
  /** undefined = leave unchanged, null = reset to default */
  sectionItemOrder?: Record<string, string[]> | null;
  /** Full favorites arrangement: new order + labels. undefined = leave unchanged. */
  favorites?: Array<{ id: string; label: string }>;
}) {
  if (user.isImpersonating) {
    return;
  }

  const currentSideMenu = SideMenuPreferences.parse(user.dashboardPreferences.sideMenu ?? {});
  const next: SideMenuPreferences = { ...currentSideMenu };

  if (sectionOrder !== undefined) {
    next.sectionOrder = sectionOrder && sectionOrder.length > 0 ? sectionOrder : undefined;
  }

  if (hiddenItems !== undefined) {
    next.hiddenItems = hiddenItems && Object.keys(hiddenItems).length > 0 ? hiddenItems : undefined;
  }

  if (sectionItemOrder !== undefined) {
    next.sectionItemOrder =
      sectionItemOrder && Object.keys(sectionItemOrder).length > 0 ? sectionItemOrder : undefined;
  }

  if (favorites !== undefined) {
    const current = currentSideMenu.favorites ?? [];
    const byId = new Map(current.map((f) => [f.id, f]));
    const rearranged: FavoritePage[] = [];

    for (const { id, label } of favorites) {
      const existing = byId.get(id);
      if (!existing) continue;
      const trimmed = label.trim();
      rearranged.push({ ...existing, label: trimmed.length > 0 ? trimmed : existing.label });
      byId.delete(id);
    }

    // Favorites the payload didn't mention (e.g. added mid-edit) keep their place at the end
    for (const favorite of current) {
      if (byId.has(favorite.id)) {
        rearranged.push(favorite);
      }
    }

    next.favorites = rearranged.length > 0 ? rearranged : undefined;
  }

  return saveSideMenu(user, SideMenuPreferences.parse(next));
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
