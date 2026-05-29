/**
 * Chart color palette defined in HSL (Hue, Saturation, Lightness).
 *
 * HSL is a human-friendly color model:
 *   h: 0–360  (hue — position on the color wheel: 0=red, 120=green, 240=blue)
 *   s: 0–100  (saturation — 0 is gray, 100 is full color)
 *   l: 0–100  (lightness — 0 is black, 50 is pure color, 100 is white)
 */

interface HSLColor {
  h: number;
  s: number;
  l: number;
}

interface ChartColorDef {
  name: string;
  hsl: HSLColor;
}

// ---------------------------------------------------------------------------
// Palette — 30 distinct colors for chart series, defined in HSL
// ---------------------------------------------------------------------------
const CHART_COLOR_DEFS: ChartColorDef[] = [
  // Primary colors (high contrast, spread across hue wheel)
  { name: "Purple", hsl: { h: 252, s: 98, l: 66 } },
  { name: "Green", hsl: { h: 142, s: 71, l: 45 } },
  { name: "Amber", hsl: { h: 38, s: 92, l: 50 } },
  { name: "Red", hsl: { h: 0, s: 84, l: 60 } },
  { name: "Cyan", hsl: { h: 189, s: 95, l: 43 } },
  { name: "Pink", hsl: { h: 330, s: 81, l: 60 } },
  { name: "Violet", hsl: { h: 258, s: 90, l: 66 } },
  { name: "Teal", hsl: { h: 173, s: 80, l: 40 } },
  { name: "Orange", hsl: { h: 25, s: 95, l: 53 } },
  { name: "Indigo", hsl: { h: 239, s: 84, l: 67 } },
  // Extended palette
  { name: "Lime", hsl: { h: 84, s: 81, l: 44 } },
  { name: "Sky", hsl: { h: 199, s: 89, l: 48 } },
  { name: "Rose", hsl: { h: 350, s: 89, l: 60 } },
  { name: "Fuchsia", hsl: { h: 271, s: 91, l: 65 } },
  { name: "Yellow", hsl: { h: 45, s: 93, l: 47 } },
  { name: "Emerald", hsl: { h: 160, s: 84, l: 39 } },
  { name: "Blue", hsl: { h: 217, s: 91, l: 60 } },
  { name: "Magenta", hsl: { h: 292, s: 84, l: 61 } },
  { name: "Stone", hsl: { h: 25, s: 5, l: 45 } },
  { name: "Gold", hsl: { h: 48, s: 96, l: 53 } },
  // Additional distinct colors (lighter variants)
  { name: "Turquoise", hsl: { h: 173, s: 66, l: 50 } },
  { name: "Light Orange", hsl: { h: 27, s: 96, l: 61 } },
  { name: "Yellow-Green", hsl: { h: 83, s: 78, l: 55 } },
  { name: "Light Blue", hsl: { h: 198, s: 93, l: 60 } },
  { name: "Light Purple", hsl: { h: 270, s: 95, l: 75 } },
  { name: "Light Green", hsl: { h: 142, s: 69, l: 58 } },
  { name: "Light Amber", hsl: { h: 43, s: 96, l: 56 } },
  { name: "Light Pink", hsl: { h: 329, s: 86, l: 70 } },
  { name: "Light Cyan", hsl: { h: 187, s: 92, l: 69 } },
  { name: "Light Indigo", hsl: { h: 235, s: 89, l: 74 } },
];

// ---------------------------------------------------------------------------
// HSL ↔ Hex conversion
// ---------------------------------------------------------------------------

/** Convert an HSL color (h: 0–360, s: 0–100, l: 0–100) to a hex string */
function hslToHex({ h, s, l }: HSLColor): string {
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const hPrime = h / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = lNorm - c / 2;

  let r1: number, g1: number, b1: number;

  if (hPrime < 1) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (hPrime < 2) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else if (hPrime < 3) {
    r1 = 0;
    g1 = c;
    b1 = x;
  } else if (hPrime < 4) {
    r1 = 0;
    g1 = x;
    b1 = c;
  } else if (hPrime < 5) {
    r1 = x;
    g1 = 0;
    b1 = c;
  } else {
    r1 = c;
    g1 = 0;
    b1 = x;
  }

  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

/** Convert a hex string to HSL (h: 0–360, s: 0–100, l: 0–100) */
function hexToHsl(hex: string): HSLColor {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) {
    return { h: 0, s: 0, l: Math.round(l * 100) };
  }

  const s = delta / (1 - Math.abs(2 * l - 1));

  let h: number;
  if (max === r) {
    h = 60 * (((g - b) / delta + 6) % 6);
  } else if (max === g) {
    h = 60 * ((b - r) / delta + 2);
  } else {
    h = 60 * ((r - g) / delta + 4);
  }

  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

// ---------------------------------------------------------------------------
// Derived hex palette (for consumers that need plain hex strings)
// ---------------------------------------------------------------------------

/** Color palette for chart series — 30 distinct hex colors derived from HSL definitions */
const CHART_COLORS: string[] = CHART_COLOR_DEFS.map((def) => hslToHex(def.hsl));

/** Get the hex color for a series by its index (wraps around) */
export function getSeriesColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

// ---------------------------------------------------------------------------
// Hue-sorted palette (rainbow order for color pickers)
// ---------------------------------------------------------------------------

const SATURATION_THRESHOLD = 10;

/**
 * Chart colors sorted by perceived hue — the natural rainbow order
 * that humans expect: red -> orange -> yellow -> green -> cyan -> blue -> purple -> pink.
 *
 * Very desaturated colors (like grays) are placed at the end since they don't
 * have a strong hue.
 */
export const CHART_COLORS_BY_HUE: string[] = [...CHART_COLOR_DEFS]
  .sort((a, b) => {
    const aIsGray = a.hsl.s < SATURATION_THRESHOLD;
    const bIsGray = b.hsl.s < SATURATION_THRESHOLD;

    // Push desaturated colors to the end
    if (aIsGray && !bIsGray) return 1;
    if (!aIsGray && bIsGray) return -1;
    if (aIsGray && bIsGray) return a.hsl.l - b.hsl.l;

    // Sort by hue, then by saturation (more vivid first), then by lightness
    if (a.hsl.h !== b.hsl.h) return a.hsl.h - b.hsl.h;
    if (a.hsl.s !== b.hsl.s) return b.hsl.s - a.hsl.s;
    return a.hsl.l - b.hsl.l;
  })
  .map((def) => hslToHex(def.hsl));
