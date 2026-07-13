import { useState } from "react";

/**
 * Normalize any CSS color (hex, oklch, hsl, ...) to rgb()/rgba() by rendering
 * it to a 1x1 canvas. framer-motion can only interpolate hex/rgb/hsl, while
 * Tailwind v4's default palette is oklch.
 */
function toRgb(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return color;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

/**
 * Resolve a theme CSS variable to a concrete, animatable color once on mount.
 * framer-motion can't interpolate `var()` strings or oklch values, so animated
 * colors must be resolved and normalized first. The fallback is used during
 * SSR and should match the default dark theme (see tailwind.css).
 */
export function useThemeColor(variable: `--${string}`, fallback: string): string {
  const [color] = useState(() => {
    if (typeof document === "undefined") return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return value ? toRgb(value) : fallback;
  });
  return color;
}
