import { $transaction, prisma } from "~/db.server";
import { logger } from "./logger.server";
import { type UserFromSession } from "./session.server";
import {
  type DashboardPreferences,
  type FavoritePage,
  parseDashboardPreferences,
  SideMenuPreferences,
} from "~/utils/dashboardPreferences";

export type { DashboardPreferences, FavoritePage } from "~/utils/dashboardPreferences";

import { type SideMenuSectionId } from "~/components/navigation/sideMenuTypes";
export type { SideMenuSectionId };

import {
  type SystemDarkTheme,
  type SystemLightTheme,
  type ThemePreference,
} from "~/utils/themePreference";
export { type ThemePreference } from "~/utils/themePreference";

export function getDashboardPreferences(data?: any | null): DashboardPreferences {
  return parseDashboardPreferences(data, (error) => {
    logger.error("Failed to parse DashboardPreferences", { data, error });
  });
}

/**
 * Every preference writer is a read-modify-write over one JSON column, and several fire
 * concurrently (debounced collapse/width, favorite toggles, the customize modal, dashboard
 * reorders). Each write re-reads the row under a FOR UPDATE lock so concurrent writers
 * serialize instead of clobbering each other's fields with stale reads — without the lock, a
 * debounced collapse write could resurrect customizations the modal's Reset just cleared.
 *
 * Return undefined from `mutate` to skip the write (no-op update).
 */
async function mutateDashboardPreferences(
  userId: string,
  mutate: (current: DashboardPreferences) => DashboardPreferences | undefined
) {
  return await $transaction(
    prisma,
    "mutateDashboardPreferences",
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ dashboardPreferences: unknown }>>`
      SELECT "dashboardPreferences" FROM "User" WHERE id = ${userId} FOR UPDATE
    `;
      if (rows.length === 0) {
        return undefined;
      }

      const updated = mutate(getDashboardPreferences(rows[0].dashboardPreferences));
      if (!updated) {
        return undefined;
      }

      return await tx.user.update({
        where: {
          id: userId,
        },
        data: {
          dashboardPreferences: updated,
        },
      });
    },
    // Concurrent writers queue on the row lock, so under load (several debounced writes plus a
    // revalidation burst) a transaction can time out acquiring a connection or the lock; those
    // codes are retriable and preference writes are idempotent.
    { maxRetries: 3 }
  );
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

  // Fast path: this runs on nearly every navigation (env layout loader), so skip the locked
  // transaction when the session snapshot already matches. The in-transaction check below stays
  // authoritative for the rare stale-snapshot case.
  if (
    user.dashboardPreferences.currentProjectId === projectId &&
    user.dashboardPreferences.projects[projectId]?.currentEnvironment?.id === environmentId
  ) {
    return;
  }

  return mutateDashboardPreferences(user.id, (prefs) => {
    //only update if the existing preferences are different
    if (
      prefs.currentProjectId === projectId &&
      prefs.projects[projectId]?.currentEnvironment?.id === environmentId
    ) {
      return undefined;
    }

    return {
      ...prefs,
      currentProjectId: projectId,
      projects: {
        ...prefs.projects,
        [projectId]: {
          ...prefs.projects[projectId],
          currentEnvironment: { id: environmentId },
        },
      },
    };
  });
}

export async function updateThemePreference({
  user,
  theme,
}: {
  user: UserFromSession;
  theme: ThemePreference;
}) {
  if (user.isImpersonating) {
    return;
  }

  if (user.dashboardPreferences.theme === theme) {
    return;
  }

  // Narrow jsonb_set write: a full-blob update from the session snapshot can
  // race with other preference writes and drop unrelated fields.
  return prisma.$executeRaw`
    UPDATE "User"
    SET "dashboardPreferences" = jsonb_set(
      COALESCE(
        "dashboardPreferences",
        '{"version":"1","projects":{}}'::jsonb
      ),
      '{theme}',
      to_jsonb(${theme}::text)
    )
    WHERE id = ${user.id}
  `;
}

export async function updateContrastPreference({
  user,
  contrast,
}: {
  user: UserFromSession;
  contrast: number;
}) {
  if (user.isImpersonating) {
    return;
  }

  if (user.dashboardPreferences.contrast === contrast) {
    return;
  }

  // Narrow jsonb_set write: see updateThemePreference.
  return prisma.$executeRaw`
    UPDATE "User"
    SET "dashboardPreferences" = jsonb_set(
      COALESCE(
        "dashboardPreferences",
        '{"version":"1","projects":{}}'::jsonb
      ),
      '{contrast}',
      to_jsonb(${contrast}::int)
    )
    WHERE id = ${user.id}
  `;
}

export async function updateIconContrastPreference({
  user,
  iconContrast,
}: {
  user: UserFromSession;
  iconContrast: boolean;
}) {
  if (user.isImpersonating) {
    return;
  }

  if ((user.dashboardPreferences.iconContrast ?? false) === iconContrast) {
    return;
  }

  // Narrow jsonb_set write: see updateThemePreference.
  return prisma.$executeRaw`
    UPDATE "User"
    SET "dashboardPreferences" = jsonb_set(
      COALESCE(
        "dashboardPreferences",
        '{"version":"1","projects":{}}'::jsonb
      ),
      '{iconContrast}',
      to_jsonb(${iconContrast}::boolean)
    )
    WHERE id = ${user.id}
  `;
}

export async function updateUnderlineLinksPreference({
  user,
  underlineLinks,
}: {
  user: UserFromSession;
  underlineLinks: boolean;
}) {
  if (user.isImpersonating) {
    return;
  }

  if ((user.dashboardPreferences.underlineLinks ?? false) === underlineLinks) {
    return;
  }

  // Narrow jsonb_set write: see updateThemePreference.
  return prisma.$executeRaw`
    UPDATE "User"
    SET "dashboardPreferences" = jsonb_set(
      COALESCE(
        "dashboardPreferences",
        '{"version":"1","projects":{}}'::jsonb
      ),
      '{underlineLinks}',
      to_jsonb(${underlineLinks}::boolean)
    )
    WHERE id = ${user.id}
  `;
}

/**
 * Which theme `system` resolves to at one end of the OS setting. `end` names the
 * key, so both ends share this one narrow jsonb_set write.
 */
export async function updateSystemThemePreference({
  user,
  end,
  theme,
}: {
  user: UserFromSession;
  end: "systemLightTheme" | "systemDarkTheme";
  theme: SystemLightTheme | SystemDarkTheme;
}) {
  if (user.isImpersonating) {
    return;
  }

  if (user.dashboardPreferences[end] === theme) {
    return;
  }

  // Narrow jsonb_set write: see updateThemePreference. The key is a checked
  // union, never caller-supplied text.
  const key = end === "systemLightTheme" ? "{systemLightTheme}" : "{systemDarkTheme}";
  return prisma.$executeRaw`
    UPDATE "User"
    SET "dashboardPreferences" = jsonb_set(
      COALESCE(
        "dashboardPreferences",
        '{"version":"1","projects":{}}'::jsonb
      ),
      ${key}::text[],
      to_jsonb(${theme}::text)
    )
    WHERE id = ${user.id}
  `;
}

export async function clearCurrentProject({ user }: { user: UserFromSession }) {
  if (user.isImpersonating) {
    return;
  }

  return mutateDashboardPreferences(user.id, (prefs) => ({
    ...prefs,
    currentProjectId: undefined,
  }));
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

  return mutateDashboardPreferences(user.id, (prefs) => {
    // Parse with schema to apply defaults, then overlay any new values
    const currentSideMenu = SideMenuPreferences.parse(prefs.sideMenu ?? {});

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
      return undefined;
    }

    return { ...prefs, sideMenu: updatedSideMenu };
  });
}

/** The most favorites a user can save; a sanity cap, not a product limit. */
const MAX_FAVORITES = 50;

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

  return mutateDashboardPreferences(user.id, (prefs) => {
    const currentSideMenu = SideMenuPreferences.parse(prefs.sideMenu ?? {});
    const favorites = currentSideMenu.favorites ?? [];

    // The star is a toggle keyed on the exact URL, so an existing entry means we're already done
    if (favorites.some((f) => f.url === favorite.url)) {
      return undefined;
    }

    if (favorites.length >= MAX_FAVORITES) {
      return undefined;
    }

    // Newest favorites go to the top of the section
    return {
      ...prefs,
      sideMenu: { ...currentSideMenu, favorites: [favorite, ...favorites] },
    };
  });
}

export async function removeFavorite({ user, id }: { user: UserFromSession; id: string }) {
  if (user.isImpersonating) {
    return;
  }

  return mutateDashboardPreferences(user.id, (prefs) => {
    const currentSideMenu = SideMenuPreferences.parse(prefs.sideMenu ?? {});
    const favorites = currentSideMenu.favorites ?? [];
    const remaining = favorites.filter((f) => f.id !== id);

    if (remaining.length === favorites.length) {
      return undefined;
    }

    return {
      ...prefs,
      sideMenu: {
        ...currentSideMenu,
        favorites: remaining.length > 0 ? remaining : undefined,
      },
    };
  });
}

/**
 * Remove any favorites whose URL contains the given substring. Used when the favorited entity
 * itself is deleted (e.g. a custom dashboard's friendly id) so the side menu doesn't keep a
 * dead link.
 */
export async function removeFavoritesByUrlSubstring({
  user,
  substring,
}: {
  user: UserFromSession;
  substring: string;
}) {
  if (user.isImpersonating) {
    return;
  }

  return mutateDashboardPreferences(user.id, (prefs) => {
    const currentSideMenu = SideMenuPreferences.parse(prefs.sideMenu ?? {});
    const favorites = currentSideMenu.favorites ?? [];
    const remaining = favorites.filter((favorite) => !favorite.url.includes(substring));

    if (remaining.length === favorites.length) {
      return undefined;
    }

    return {
      ...prefs,
      sideMenu: {
        ...currentSideMenu,
        favorites: remaining.length > 0 ? remaining : undefined,
      },
    };
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

  return mutateDashboardPreferences(user.id, (prefs) => {
    const currentSideMenu = SideMenuPreferences.parse(prefs.sideMenu ?? {});
    const favorites = currentSideMenu.favorites ?? [];

    const favorite = favorites.find((f) => f.id === id);
    if (!favorite || favorite.label === label) {
      return undefined;
    }

    return {
      ...prefs,
      sideMenu: {
        ...currentSideMenu,
        favorites: favorites.map((f) => (f.id === id ? { ...f, label } : f)),
      },
    };
  });
}

export async function updateSideMenuCustomization({
  user,
  sectionOrder,
  hiddenItems,
  sectionItemOrder,
  favorites,
  removedFavoriteIds,
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
  /** Favorites deleted from the customize modal. */
  removedFavoriteIds?: string[];
}) {
  if (user.isImpersonating) {
    return;
  }

  return mutateDashboardPreferences(user.id, (prefs) => {
    const currentSideMenu = SideMenuPreferences.parse(prefs.sideMenu ?? {});
    const next: SideMenuPreferences = { ...currentSideMenu };

    if (sectionOrder !== undefined) {
      next.sectionOrder = sectionOrder && sectionOrder.length > 0 ? sectionOrder : undefined;
    }

    if (hiddenItems !== undefined) {
      next.hiddenItems =
        hiddenItems && Object.keys(hiddenItems).length > 0 ? hiddenItems : undefined;
    }

    if (sectionItemOrder !== undefined) {
      next.sectionItemOrder =
        sectionItemOrder && Object.keys(sectionItemOrder).length > 0 ? sectionItemOrder : undefined;
    }

    if (favorites !== undefined || removedFavoriteIds !== undefined) {
      const removed = new Set(removedFavoriteIds ?? []);
      const current = (currentSideMenu.favorites ?? []).filter((f) => !removed.has(f.id));
      const byId = new Map(current.map((f) => [f.id, f]));
      const rearranged: FavoritePage[] = [];

      for (const { id, label } of favorites ?? []) {
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

    return { ...prefs, sideMenu: SideMenuPreferences.parse(next) };
  });
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

  return mutateDashboardPreferences(user.id, (prefs) => {
    const currentSideMenu = SideMenuPreferences.parse(prefs.sideMenu ?? {});
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

    return { ...prefs, sideMenu: updatedSideMenu };
  });
}
