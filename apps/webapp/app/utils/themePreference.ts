import { z } from "zod";

// Shared between server (dashboard preferences) and client (theme UI, system
// theme sync) - must stay free of server-only imports.
export const ThemePreference = z.enum(["classic", "system", "dark", "light"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/** Coerce any stored/legacy value into a valid preference. Missing or unknown
 * values fall back to `dark` - the new dark theme is the default (pinned, not
 * system-resolved, so nobody gets surprised by light mode). */
export function normalizeThemePreference(value: unknown): ThemePreference {
  const result = ThemePreference.safeParse(value);
  return result.success ? result.data : "dark";
}

/** The default dark theme ships with a slight contrast bump. */
const DEFAULT_THEME_CONTRAST = 50;

/** Interface contrast for the System themes, 0 to 100. Missing or invalid
 * values fall back to the default bump. */
export function normalizeThemeContrast(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return DEFAULT_THEME_CONTRAST;
  return Math.min(100, Math.max(0, Math.round(num)));
}
