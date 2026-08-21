import { useEffect, useState } from "react";
import {
  type SystemDarkTheme,
  type SystemLightTheme,
  type ThemePreference,
} from "~/utils/themePreference";

/** Which theme `system` lands on at each end of the OS setting. */
export type SystemThemes = { light: SystemLightTheme; dark: SystemDarkTheme };

const DEFAULT_SYSTEM_THEMES: SystemThemes = { light: "light", dark: "dark" };

/** Which end of the scale a theme sits on. */
export type ThemeAppearance = "dark" | "light";

function themeAppearance(preference: ThemePreference, prefersDark: boolean): ThemeAppearance {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference === "light" || preference === "white" ? "light" : "dark";
}

/**
 * Resolved appearance, tracking the OS while the preference is `system`. Defaults
 * to dark before the effect runs, matching root.tsx's SSR fallback.
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

/** Only `system` needs resolving; it lands on the variant picked for that end. */
export function resolveThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
  systemThemes: SystemThemes = DEFAULT_SYSTEM_THEMES
): ThemePreference {
  if (preference !== "system") return preference;
  return prefersDark ? systemThemes.dark : systemThemes.light;
}

/** Just the percent; each theme maps it onto its own range in CSS. */
export function applyThemeContrast(percent: number) {
  document.documentElement.style.setProperty("--theme-contrast-percent", String(percent / 100));
}

/** Applies a theme immediately, rather than waiting for the loader round-trip. */
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
 * Keeps `data-theme` in sync with the preference. Pinned themes are written
 * explicitly: React can skip a write its virtual DOM thinks already matched,
 * while root.tsx's inline script had changed the real attribute.
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
    // Destructured so a fresh object each render doesn't re-run this
  }, [preference, light, dark]);
}
