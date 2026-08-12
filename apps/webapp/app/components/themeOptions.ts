import { ComputerDesktopIcon, SwatchIcon } from "@heroicons/react/24/outline";
import { type FunctionComponent } from "react";
import { CircleFilledIcon } from "~/assets/icons/CircleFilledIcon";
import { CircleOutlineIcon } from "~/assets/icons/CircleOutlineIcon";
import { MoonIcon } from "~/assets/icons/MoonIcon";
import { SunIcon } from "~/assets/icons/SunIcon";
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
  { value: "system", label: "System", icon: ComputerDesktopIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** Dark and Light with their surfaces pinned flat, so grid lines carry the
 *  layout. Account page only, alongside Classic. */
const FLAT_OPTIONS: ThemeOption[] = [
  { value: "black", label: "Black", icon: CircleFilledIcon },
  { value: "white", label: "White", icon: CircleOutlineIcon },
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
