import { useState } from "react";

/**
 * Resolve a theme CSS variable to its concrete color once on mount.
 * framer-motion can't interpolate `var()` strings, so animated colors must be
 * resolved to real values first. The fallback is used during SSR and should
 * match the default dark theme (see tailwind.css).
 */
export function useThemeColor(variable: `--${string}`, fallback: string): string {
  const [color] = useState(() => {
    if (typeof document === "undefined") return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
  });
  return color;
}
