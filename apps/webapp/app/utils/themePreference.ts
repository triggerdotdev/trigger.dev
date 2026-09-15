import { z } from "zod";

// Shared with the client, so no server-only imports.
export const ThemePreference = z.enum(["system", "dark", "light", "black", "white"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/* Which theme `system` resolves to at each end of the OS setting. */
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

/** Missing, unknown and legacy values (including the removed `classic`) fall
 *  back to `dark`. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  const result = ThemePreference.safeParse(value);
  return result.success ? result.data : "dark";
}

/** 0 is the base palette; the slider only ever adds contrast on top. */
const DEFAULT_THEME_CONTRAST = 0;

/** The "Stronger colors" preference. Stored as `iconContrast`, which predates it
 *  covering charts and shapes too. */
export function normalizeIconContrast(value: unknown): boolean {
  return value === true;
}

export function normalizeUnderlineLinks(value: unknown): boolean {
  return value === true;
}

/**
 * A 0-100 position within the active theme's own range, not a shared scale, so
 * 35% stays 35% across themes. Each theme maps it in tailwind.css.
 */
export function normalizeThemeContrast(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return DEFAULT_THEME_CONTRAST;
  return Math.min(100, Math.max(0, Math.round(num)));
}
