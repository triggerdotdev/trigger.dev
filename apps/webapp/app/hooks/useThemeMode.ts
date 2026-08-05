import { useEffect, useState } from "react";

/** Whether the active theme paints on dark or light surfaces. */
export type ThemeMode = "dark" | "light";

/**
 * The active theme's mode, for colors that can't come from a CSS variable
 * (canvas, props that take a color string). Prefer a theme-aware token
 * otherwise.
 *
 * `light` is the only non-dark mode, so anything else resolves to `dark`.
 * Resolution happens in an effect so server and hydration renders agree, since
 * the pre-paint script in `root.tsx` can flip `data-theme` before hydration.
 */
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("dark");
  useEffect(() => {
    const resolve = () => {
      setMode(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
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
