import { useEffect, useState } from "react";
import { SystemLightTheme } from "~/utils/themePreference";

export type ThemeMode = "dark" | "light";

/* Which themes read as light. Taken from the enum that also drives the "Light"
   end of the `system` preference, so a new theme only has to be classified once
   - anything not in here (dark, black) reads as dark. */
const LIGHT_THEMES = new Set<string>(SystemLightTheme.options);

/**
 * The active theme's mode, for colors that can't come from a CSS variable. Resolved in an
 * effect so server and hydration renders agree; `root.tsx` can flip `data-theme` pre-paint.
 */
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("dark");
  useEffect(() => {
    const resolve = () => {
      const theme = document.documentElement.getAttribute("data-theme");
      setMode(theme !== null && LIGHT_THEMES.has(theme) ? "light" : "dark");
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return mode;
}
