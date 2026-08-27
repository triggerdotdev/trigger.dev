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

/** Shared by every theme picker, in display order. */
export const THEME_OPTIONS: ThemeOption[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** Account page only. Icons are the dark-theme pair; `themeOptionIcon` swaps them. */
const FLAT_OPTIONS: ThemeOption[] = [
  { value: "white", label: "White", icon: CircleFilledIcon },
  { value: "black", label: "Black", icon: CircleOutlineIcon },
];

export const ALL_THEME_OPTIONS: ThemeOption[] = [...THEME_OPTIONS, ...FLAT_OPTIONS];

export const THEME_OPTIONS_BY_VALUE = Object.fromEntries(
  ALL_THEME_OPTIONS.map((option) => [option.value, option])
) as Record<ThemePreference, ThemeOption>;

/**
 * Black and White show the active background through the circle: the option
 * matching the current end is a ring, the opposing one a solid disc.
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

export const SYSTEM_LIGHT_OPTIONS: ThemeOption[] = ALL_THEME_OPTIONS.filter(
  (option) => option.value === "light" || option.value === "white"
);
export const SYSTEM_DARK_OPTIONS: ThemeOption[] = ALL_THEME_OPTIONS.filter(
  (option) => option.value === "dark" || option.value === "black"
);
