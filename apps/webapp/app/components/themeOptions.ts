import { SwatchIcon } from "@heroicons/react/24/outline";
import { type FunctionComponent } from "react";
import { CircleFilledIcon } from "~/assets/icons/CircleFilledIcon";
import { CircleOutlineIcon } from "~/assets/icons/CircleOutlineIcon";
import { MonitorIcon } from "~/assets/icons/MonitorIcon";
import { MoonIcon } from "~/assets/icons/MoonIcon";
import { SunIcon } from "~/assets/icons/SunIcon";
import { type ThemeAppearance } from "~/hooks/useSystemThemeSync";
import { type ThemePreference } from "~/utils/themePreference";

export type ThemeOption = {
  value: ThemePreference;
  label: string;
  icon: FunctionComponent<{ className?: string }>;
};

/** The themes offered everywhere, in display order - including the account
 *  popover's submenu. Shared by every theme picker so the labels and icons
 *  can't drift apart. */
export const THEME_OPTIONS: ThemeOption[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** Light and Dark with their surfaces pinned flat, so grid lines carry the
 *  layout. Account page only, alongside Classic. The icons here are the
 *  dark-theme pair; `themeOptionIcon` swaps them per active theme. */
const FLAT_OPTIONS: ThemeOption[] = [
  { value: "white", label: "White", icon: CircleFilledIcon },
  { value: "black", label: "Black", icon: CircleOutlineIcon },
];

/** Legacy theme, offered on the account page only. */
export const CLASSIC_OPTION: ThemeOption = {
  value: "classic",
  label: "Classic",
  icon: SwatchIcon,
};

/** Every theme, for the account page's full picker. */
export const ALL_THEME_OPTIONS: ThemeOption[] = [...THEME_OPTIONS, ...FLAT_OPTIONS, CLASSIC_OPTION];

export const THEME_OPTIONS_BY_VALUE = Object.fromEntries(
  ALL_THEME_OPTIONS.map((option) => [option.value, option])
) as Record<ThemePreference, ThemeOption>;

/**
 * The icon to draw for an option under the active theme.
 *
 * Black and White show the active theme's background *through* the circle: the
 * option matching the current end of the scale is a ring, so the background
 * reads through it, and the opposing one is a solid disc in the foreground
 * colour. On a dark theme that makes Black a ring and White a filled disc; on a
 * light theme it flips. Every other option has one fixed icon.
 */
export function themeOptionIcon(option: ThemeOption, appearance: ThemeAppearance) {
  if (option.value === "black") {
    return appearance === "dark" ? CircleOutlineIcon : CircleFilledIcon;
  }
  if (option.value === "white") {
    return appearance === "light" ? CircleOutlineIcon : CircleFilledIcon;
  }
  return option.icon;
}

/** The two candidates for each end of the `system` setting. */
export const SYSTEM_LIGHT_OPTIONS: ThemeOption[] = ALL_THEME_OPTIONS.filter(
  (option) => option.value === "light" || option.value === "white"
);
export const SYSTEM_DARK_OPTIONS: ThemeOption[] = ALL_THEME_OPTIONS.filter(
  (option) => option.value === "dark" || option.value === "black"
);
