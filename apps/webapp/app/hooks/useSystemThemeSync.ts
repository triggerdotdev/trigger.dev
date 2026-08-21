import { useEffect, useState } from "react";
import {
  type SystemDarkTheme,
  type SystemLightTheme,
  type ThemePreference,
} from "~/utils/themePreference";

/** Which theme `system` lands on at each end of the OS setting. */
export type SystemThemes = { light: SystemLightTheme; dark: SystemDarkTheme };

const DEFAULT_SYSTEM_THEMES: SystemThemes = { light: "light", dark: "dark" };

/** Which end of the scale a theme sits on. Classic and Black are dark; White is
 *  light; `system` follows the OS. */
export type ThemeAppearance = "dark" | "light";

function themeAppearance(preference: ThemePreference, prefersDark: boolean): ThemeAppearance {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference === "light" || preference === "white" ? "light" : "dark";
}

/**
 * The resolved appearance, tracking OS changes while the preference is `system`.
 *
 * Defaults to dark before the effect runs, matching the SSR fallback in root.tsx,
 * so the first client render agrees with the server's.
 */
export function useThemeAppearance(preference: ThemePreference): ThemeAppearance {
  const [prefersDark, setPrefersDark] = useState(true);

  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setPrefersDark(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  return themeAppearance(preference, prefersDark);
}

/**
 * The theme a preference resolves to. Only `system` needs resolving, and it lands
 * on whichever variant the user picked for that end of the OS setting - Light or
 * White, Dark or Black.
 */
export function resolveThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
  systemThemes: SystemThemes = DEFAULT_SYSTEM_THEMES
): ThemePreference {
  if (preference !== "system") return preference;
  return prefersDark ? systemThemes.dark : systemThemes.light;
}

/**
 * Puts a preference on <html> now, resolving `system` against the OS once. Use
 * this to apply a theme the moment it's picked: the preference round-trips
 * through the server and comes back via the root loader, and anything that waits
 * for that is at the mercy of whether the revalidation actually lands.
 */
/**
 * Write the contrast preference to the document.
 *
 * Just the percent: each theme maps it onto its own range in CSS, so there's
 * nothing here that needs to know which theme resolved. That used to write
 * `--theme-contrast` directly, which meant the live preview and the server
 * render could disagree, and a value outside 0-100 silently did nothing.
 */
export function applyThemeContrast(percent: number) {
  document.documentElement.style.setProperty("--theme-contrast-percent", String(percent / 100));
}

export function applyThemePreference(
  preference: ThemePreference,
  systemThemes: SystemThemes = DEFAULT_SYSTEM_THEMES
) {
  const prefersDark =
    preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute(
    "data-theme",
    resolveThemePreference(preference, prefersDark, systemThemes)
  );
  document.documentElement.setAttribute("data-theme-preference", preference);
}

/**
 * Keeps `data-theme` on <html> in sync with the preference. For `system` it
 * follows the OS color scheme live; for pinned themes it writes the attribute
 * explicitly - React can skip the write when its virtual DOM already matched
 * the SSR fallback while the inline script had changed the real attribute.
 * The single resolution rule (dark vs light) lives here and in the blocking
 * inline script in root.tsx; downstream consumers react to the `data-theme`
 * mutation (see useThemeColor).
 */
export function useSystemThemeSync(
  preference: ThemePreference,
  systemThemes: SystemThemes = DEFAULT_SYSTEM_THEMES
) {
  const { light, dark } = systemThemes;

  useEffect(() => {
    if (preference !== "system") {
      applyThemePreference(preference);
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.setAttribute("data-theme", media.matches ? dark : light);
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
    // Destructured so a fresh object identity each render doesn't re-run this
  }, [preference, light, dark]);
}
