import { z } from "zod";
import { SystemDarkTheme, SystemLightTheme, ThemePreference } from "~/utils/themePreference";

/* Schema and pure parsing for the User.dashboardPreferences JSON column.
   Kept out of the .server module so tests can exercise the schema without
   pulling in the server env graph. */

export const FavoritePage = z.object({
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

export const SideMenuPreferences = z.object({
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

const DashboardPreferences = z.object({
  version: z.literal("1"),
  /* An unknown value (e.g. written by a newer deploy) degrades to undefined
     instead of failing the whole blob and erasing every other setting */
  theme: ThemePreference.optional().catch(undefined),
  /** 0-100, a position within the active theme's own range. */
  contrast: z.number().int().min(0).max(100).optional().catch(undefined),
  /** Swaps the base icon and badge accents for the high-contrast set. */
  iconContrast: z.boolean().optional().catch(undefined),
  /** Underlines inline links. */
  underlineLinks: z.boolean().optional().catch(undefined),
  /** Which theme `system` resolves to at each end of the OS setting. */
  systemLightTheme: SystemLightTheme.optional().catch(undefined),
  systemDarkTheme: SystemDarkTheme.optional().catch(undefined),
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

/* A function, not a shared constant: the writers mutate through these objects,
   so each caller needs its own container */
function defaultPreferences(): DashboardPreferences {
  return {
    version: "1",
    projects: {},
  };
}

/** Parses the stored JSON, falling back to defaults on missing or invalid data. */
export function parseDashboardPreferences(
  data?: any | null,
  onError?: (error: z.ZodError) => void
): DashboardPreferences {
  if (!data) {
    return defaultPreferences();
  }

  const result = DashboardPreferences.safeParse(data);
  if (!result.success) {
    onError?.(result.error);
    return defaultPreferences();
  }

  return result.data;
}
