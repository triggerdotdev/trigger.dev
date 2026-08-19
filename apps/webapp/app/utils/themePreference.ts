import { z } from "zod";

// Shared between server (dashboard preferences) and client (theme UI, system
// theme sync) - must stay free of server-only imports.
export const ThemePreference = z.enum(["system", "dark", "light", "black", "white"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/* Which theme `system` resolves to at each end of the OS setting. Both ends have
   a flat counterpart (White, Black), so the user picks per end. */
export const SystemLightTheme = z.enum(["light", "white"]);
export type SystemLightTheme = z.infer<typeof SystemLightTheme>;
export const SystemDarkTheme = z.enum(["dark", "black"]);
export type SystemDarkTheme = z.infer<typeof SystemDarkTheme>;

export function normalizeSystemLightTheme(value: unknown): SystemLightTheme {
  const result = SystemLightTheme.safeParse(value);
  return result.success ? result.data : "light";
}

export function normalizeSystemDarkTheme(value: unknown): SystemDarkTheme {
  const result = SystemDarkTheme.safeParse(value);
  return result.success ? result.data : "dark";
}

/** Coerce any stored/legacy value into a valid preference. Missing or unknown
 * values fall back to `dark`, which is the default. This is also the upgrade
 * path off the removed `classic` theme: a stored "classic" no longer parses, so
 * it lands here and resolves to Dark - which at contrast 0 renders the exact
 * palette Classic used to. Pinned rather than system-resolved, so nobody gets
 * surprised by light mode. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  const result = ThemePreference.safeParse(value);
  return result.success ? result.data : "dark";
}

/** Dark's palette at contrast 0 is exactly the palette the Classic theme
 *  shipped, so 0 is the default: anyone arriving from Classic sees no change,
 *  and the slider only ever adds contrast on top. */
const DEFAULT_THEME_CONTRAST = 0;

/** The "Distinguish without color" accessibility preference: on swaps the
 *  default accents for the high-contrast set (solid badges, monochrome nav
 *  icons, darker chart series). Off is the default. Stored as `iconContrast`,
 *  which predates the preference covering charts and shapes too. */
export function normalizeIconContrast(value: unknown): boolean {
  return value === true;
}

/** Underlines inline links (the TextLink component). Off is the default. */
export function normalizeUnderlineLinks(value: unknown): boolean {
  return value === true;
}

/** Interface contrast for the System themes, 0 to 100. Missing or invalid
 * values fall back to the default bump. */
export function normalizeThemeContrast(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return DEFAULT_THEME_CONTRAST;
  return Math.min(100, Math.max(0, Math.round(num)));
}
