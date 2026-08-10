import { ComputerDesktopIcon, SwatchIcon } from "@heroicons/react/24/outline";
import { type FunctionComponent } from "react";
import { MoonIcon } from "~/assets/icons/MoonIcon";
import { SunIcon } from "~/assets/icons/SunIcon";
import { type ThemePreference } from "~/utils/themePreference";

export type ThemeOption = {
  value: ThemePreference;
  label: string;
  icon: FunctionComponent<{ className?: string }>;
};

/** The themes on offer, in display order. Shared by every theme picker so the
 *  labels and icons can't drift apart. */
export const THEME_OPTIONS: ThemeOption[] = [
  { value: "system", label: "System", icon: ComputerDesktopIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** Legacy theme, offered on the account page only. */
export const CLASSIC_OPTION: ThemeOption = {
  value: "classic",
  label: "Classic",
  icon: SwatchIcon,
};

/** Every theme, for the account page's full picker. */
export const ALL_THEME_OPTIONS: ThemeOption[] = [...THEME_OPTIONS, CLASSIC_OPTION];

export const THEME_OPTIONS_BY_VALUE = Object.fromEntries(
  ALL_THEME_OPTIONS.map((option) => [option.value, option])
) as Record<ThemePreference, ThemeOption>;
