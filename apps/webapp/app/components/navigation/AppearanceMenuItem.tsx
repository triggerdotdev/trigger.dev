import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { useEffect } from "react";
import { useTypedRouteLoaderData } from "remix-typedjson";
import { ToggleSwitchIcon } from "~/assets/icons/ToggleSwitchIcon";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { THEME_OPTIONS } from "~/components/themeOptions";
import { applyThemePreference } from "~/hooks/useSystemThemeSync";
import { type loader as rootLoader } from "~/root";
import { accountPath } from "~/utils/pathBuilder";
import { normalizeThemePreference, type ThemePreference } from "~/utils/themePreference";
import { SideMenuPopoverSubMenu } from "./SideMenuPopoverSubMenu";
import { SIDE_MENU_POPOVER_ITEM_ICON, SIDE_MENU_POPOVER_ITEM_LABEL } from "./sideMenuTypes";

const THEME_ACTION_PATH = "/resources/preferences/theme";

/**
 * Theme switcher for the account popover: an "Appearance" submenu listing each theme, with a check
 * against the current one. Picking a theme doesn't navigate, so the menu stays open and the new
 * theme applies underneath it. Hidden entirely while the theme switcher feature flag is off,
 * matching the account page.
 */
export function AppearanceMenuItem() {
  const rootData = useTypedRouteLoaderData<typeof rootLoader>("root");
  const fetcher = useFetcher<{ success?: boolean }>();
  const savedTheme = rootData?.themePreference;
  const systemThemes = rootData?.systemThemes;

  // A failed write would otherwise leave the optimistic theme on screen, since
  // the loader data never changes and so `useSystemThemeSync` never re-runs.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || fetcher.data.success || !savedTheme) return;
    applyThemePreference(savedTheme, systemThemes);
  }, [fetcher.state, fetcher.data, savedTheme, systemThemes]);

  if (!rootData?.showThemeSwitcher) {
    return null;
  }

  // Move the check as soon as a theme is clicked; the write follows.
  const pendingTheme = fetcher.formData?.get("theme");
  const theme =
    typeof pendingTheme === "string"
      ? normalizeThemePreference(pendingTheme)
      : rootData.themePreference;

  const pickTheme = (value: ThemePreference) => {
    // Applied here rather than waiting for the write to come back through the
    // root loader: dismissing the popover unmounts this row, and an unmounted
    // fetcher's revalidation is dropped, which left the theme untouched even
    // though the preference had saved.
    applyThemePreference(value, rootData.systemThemes);
    fetcher.submit({ theme: value }, { method: "post", action: THEME_ACTION_PATH });
  };

  return (
    // Much narrower than the standard submenu: these labels don't need the room.
    <SideMenuPopoverSubMenu title="Appearance" icon={ToggleSwitchIcon} contentClassName="min-w-36">
      <div className="flex flex-col gap-1 p-1">
        {THEME_OPTIONS.map((option) => (
          <PopoverMenuItem
            key={option.value}
            title={option.label}
            icon={option.icon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
            isSelected={theme === option.value}
            onClick={() => pickTheme(option.value)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
        <PopoverMenuItem
          to={accountPath()}
          title="More options"
          icon={EllipsisHorizontalIcon}
          leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
        />
      </div>
    </SideMenuPopoverSubMenu>
  );
}
