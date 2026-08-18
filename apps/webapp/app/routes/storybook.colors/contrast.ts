/* Live contrast measurement for the Colors audit page. Ratios are read off real
   DOM nodes rather than hard-coded, so a swatch always reports what that
   combination resolves to - theme, the interface contrast slider and the
   Stronger colors preference all feed into the same custom properties, and any
   of them can move a token. Because the measurement walks the DOM for its
   background, a column that pins `data-theme` on a wrapper gets that theme's
   answer without the page having to switch. */

export type Rgb = { r: number; g: number; b: number; a: number };

/** WCAG 1.4.11: icons, chart series, borders - anything non-text. */
export const NON_TEXT_THRESHOLD = 3;
/** WCAG 1.4.3: body-sized text, which is what every status label is. */
export const TEXT_THRESHOLD = 4.5;

let parseContext: CanvasRenderingContext2D | null | undefined;

function getParseContext() {
  if (parseContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    parseContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  return parseContext;
}

/**
 * Any CSS color the browser can parse -> 8-bit RGBA. Goes through a canvas
 * rather than a regex because computed values here are not all `rgb()`:
 * `color-mix()` (the contrast ramp) and `oklab()` both show up, and the exact
 * serialization varies by browser version.
 */
export function parseCssColor(value: string | null | undefined): Rgb | null {
  if (!value) return null;

  const ctx = getParseContext();
  if (!ctx) return null;

  // An unparseable assignment leaves fillStyle untouched, so try it against two
  // different seeds: if both land on the same value the assignment took.
  ctx.fillStyle = "#000000";
  ctx.fillStyle = value;
  const fromBlack = ctx.fillStyle;
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = value;
  if (ctx.fillStyle !== fromBlack) return null;

  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);

  const [r, g, b, alpha] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: alpha / 255 };
}

/** Flatten a translucent color onto whatever sits behind it. */
export function compositeOver(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/**
 * The surface an element actually sits on: walk up until something opaque is
 * found, then composite the translucent layers back down. Tinted chips
 * (`bg-error/10` and friends) are everywhere in this audit, so stopping at the
 * first background-color would report the wrong backdrop.
 */
export function effectiveBackgroundColor(element: Element | null): Rgb {
  const layers: Rgb[] = [];
  let node: Element | null = element;

  while (node) {
    const color = parseCssColor(getComputedStyle(node).backgroundColor);
    if (color && color.a > 0) {
      layers.push(color);
      if (color.a >= 1) break;
    }
    node = node.parentElement;
  }

  // Nothing opaque found (only possible if the page background is unset) - fall
  // back to white, the harsher of the two ends.
  let result: Rgb = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) {
    result = compositeOver(layers[i], result);
  }
  return result;
}

function channelToLinear(channel: number) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }: Rgb) {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

export function contrastRatio(a: Rgb, b: Rgb) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The contrast between an element's own text color and the surface behind it.
 * `null` when either color can't be resolved.
 */
export function measureTextContrast(element: HTMLElement): number | null {
  const surface = effectiveBackgroundColor(element.parentElement ?? element);
  const color = parseCssColor(getComputedStyle(element).color);
  if (!color) return null;
  return contrastRatio(compositeOver(color, surface), surface);
}
