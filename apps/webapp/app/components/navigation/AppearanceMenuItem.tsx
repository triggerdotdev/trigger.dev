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

export function AppearanceMenuItem() {
  const rootData = useTypedRouteLoaderData<typeof rootLoader>("root");
  const fetcher = useFetcher<{ success?: boolean }>();
  const savedTheme = rootData?.themePreference;
  const systemThemes = rootData?.systemThemes;

  // A failed write would otherwise leave the optimistic theme on screen.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || fetcher.data.success || !savedTheme) return;
    applyThemePreference(savedTheme, systemThemes);
  }, [fetcher.state, fetcher.data, savedTheme, systemThemes]);

  if (!rootData?.showThemeSwitcher) {
    return null;
  }

  const pendingTheme = fetcher.formData?.get("theme");
  const theme =
    typeof pendingTheme === "string"
      ? normalizeThemePreference(pendingTheme)
      : rootData.themePreference;

  const pickTheme = (value: ThemePreference) => {
    // Dismissing the popover unmounts this row, and an unmounted fetcher's
    // revalidation is dropped, so apply the theme here rather than waiting.
    applyThemePreference(value, rootData.systemThemes);
    fetcher.submit({ theme: value }, { method: "post", action: THEME_ACTION_PATH });
  };

  return (
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
          isSelected={!THEME_OPTIONS.some((option) => option.value === theme)}
        />
      </div>
    </SideMenuPopoverSubMenu>
  );
}
