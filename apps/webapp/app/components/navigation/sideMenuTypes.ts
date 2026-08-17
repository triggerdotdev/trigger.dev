import { z } from "zod";

// Valid section IDs that can have their collapsed state toggled
export const SideMenuSectionIdSchema = z.enum([
  "favorites",
  "ai",
  "manage",
  "metrics",
  "deployments",
  "project-settings",
  "tasks",
]);

// Inferred type from the schema
export type SideMenuSectionId = z.infer<typeof SideMenuSectionIdSchema>;

// Size popover items to match the side-menu items, overriding the smaller small-menu-item
// defaults via tailwind-merge; icon carries the default dimmed color.
export const SIDE_MENU_POPOVER_ITEM_ICON = "h-5 w-5 text-text-dimmed";
export const SIDE_MENU_POPOVER_ITEM_LABEL = "text-[0.90625rem] font-medium tracking-[-0.01em]";

/** Default top-to-bottom order of the customizable side menu sections. */
const DEFAULT_SECTION_ORDER: SideMenuSectionId[] = [
  "favorites",
  "ai",
  "metrics",
  "deployments",
  "manage",
];

/**
 * Order entries by a saved preference. Entries missing from the saved order (e.g. a section or
 * item that shipped after the user customized) are inserted at their default position relative
 * to the entries around them, not dumped at the end — so "Favorites" still lands above "AI" for
 * users who saved an order before favorites existed.
 */
export function orderByPreference<T extends { id: string }>(
  entries: T[],
  savedOrder: string[] | undefined
): T[] {
  if (!savedOrder || savedOrder.length === 0) return entries;

  const defaultIndex = new Map(entries.map((entry, index) => [entry.id, index]));
  // Set-dedupe: a corrupted saved order with duplicate ids must not render an entry twice
  const orderedIds = [...new Set(savedOrder.filter((id) => defaultIndex.has(id)))];
  const missingIds = entries.map((entry) => entry.id).filter((id) => !orderedIds.includes(id));

  for (const id of missingIds) {
    const idDefault = defaultIndex.get(id) ?? 0;
    let insertAt = orderedIds.length;
    for (let i = 0; i < orderedIds.length; i++) {
      if ((defaultIndex.get(orderedIds[i]) ?? 0) > idDefault) {
        insertAt = i;
        break;
      }
    }
    orderedIds.splice(insertAt, 0, id);
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return orderedIds.map((id) => byId.get(id)!);
}

/** Effective hidden state for a menu item: the user's override wins, else the item's default. */
export function isItemHidden(
  item: { id: string; defaultHidden?: boolean },
  hiddenItems: Record<string, boolean> | undefined
): boolean {
  return hiddenItems?.[item.id] ?? item.defaultHidden ?? false;
}
