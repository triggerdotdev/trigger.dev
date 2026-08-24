import { useEffect, useState } from "react";

/**
 * Normalize any CSS color (hex, oklch, hsl, ...) to rgb()/rgba() by rendering
 * it to a 1x1 canvas. framer-motion can only interpolate hex/rgb/hsl, while
 * Tailwind v4's default palette is oklch.
 */
function toRgb(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return color;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

/**
 * Resolve a theme CSS variable to a concrete, animatable color.
 * framer-motion can't interpolate `var()` strings or oklch values, so animated
 * colors must be resolved and normalized first. Resolution happens in an
 * effect so server and hydration renders both use the fallback — resolving
 * during render caused hydration style mismatches. Long-lived components
 * (e.g. the side menu) outlive theme switches, so re-resolve whenever
 * `data-theme` flips on <html>.
 */
export function useThemeColor(variable: `--${string}`, fallback: string): string {
  const [color, setColor] = useState(fallback);
  useEffect(() => {
    const resolve = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
      if (value) setColor(toRgb(value));
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [variable]);
  return color;
}
