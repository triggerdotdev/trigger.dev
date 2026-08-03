import { useEffect, useState } from "react";

/** Whether the active theme paints on dark or light surfaces. */
export type ThemeMode = "dark" | "light";

/**
 * The active theme's mode, for the rare color that can't come from a CSS
 * variable — a canvas paints with concrete values, so it has to ask.
 *
 * Prefer a theme-aware token (`text-*`, `bg-*`, `var(--color-*)`) whenever the
 * color goes through CSS; this is the escape hatch for canvas and for props
 * that take a color string.
 *
 * `light` is the only mode that isn't dark, so anything else — `dark`,
 * `classic`, an unset attribute during SSR — resolves to `dark`. Resolution
 * happens in an effect so server and hydration renders agree (the pre-paint
 * script in `root.tsx` can flip `data-theme` before hydration), and a
 * `MutationObserver` keeps long-lived components correct across theme
 * switches. Same shape as `useThemeColor`.
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
