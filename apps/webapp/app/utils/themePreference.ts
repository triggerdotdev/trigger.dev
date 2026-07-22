import { z } from "zod";

// Shared between server (dashboard preferences) and client (theme UI, system
// theme sync) - must stay free of server-only imports.
export const ThemePreference = z.enum(["classic", "system", "dark", "light"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/** Coerce any stored/legacy value into a valid preference. Missing or unknown
 * values fall back to `classic` (the default dark theme). */
export function normalizeThemePreference(value: unknown): ThemePreference {
  const result = ThemePreference.safeParse(value);
  return result.success ? result.data : "classic";
}
