// Pure geometry helpers for useDraggableResizable. No DOM/React here so they're easy to unit test.

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };
export type Rect = Point & Size;
export type ResizeEdge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
export type Viewport = { width: number; height: number };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampSize(size: Size, minSize: Size, maxSize?: Size): Size {
  return {
    w: clamp(size.w, minSize.w, maxSize?.w ?? Infinity),
    h: clamp(size.h, minSize.h, maxSize?.h ?? Infinity),
  };
}

/** Keeps the rect's top-left within [padding, viewport - padding - size], shrinking padding if the viewport is too small to honor it. */
export function clampPosition(
  position: Point,
  size: Size,
  viewport: Viewport,
  padding: number
): Point {
  const maxX = Math.max(padding, viewport.width - padding - size.w);
  const maxY = Math.max(padding, viewport.height - padding - size.h);
  return {
    x: clamp(position.x, padding, maxX),
    y: clamp(position.y, padding, maxY),
  };
}

export function clampRectToViewport(rect: Rect, viewport: Viewport, padding: number): Rect {
  const position = clampPosition(
    { x: rect.x, y: rect.y },
    { w: rect.w, h: rect.h },
    viewport,
    padding
  );
  return { ...position, w: rect.w, h: rect.h };
}

/**
 * Applies a pointer delta to `start` for the given resize edge, respecting min/max size.
 * North/west edges move the opposite corner too so the far edge stays put.
 */
export function resizeRect(
  edge: ResizeEdge,
  start: Rect,
  dx: number,
  dy: number,
  minSize: Size,
  maxSize?: Size
): Rect {
  let { x, y, w, h } = start;

  if (edge.includes("e")) {
    w = clamp(start.w + dx, minSize.w, maxSize?.w ?? Infinity);
  }
  if (edge.includes("s")) {
    h = clamp(start.h + dy, minSize.h, maxSize?.h ?? Infinity);
  }
  if (edge.includes("w")) {
    w = clamp(start.w - dx, minSize.w, maxSize?.w ?? Infinity);
    x = start.x + (start.w - w);
  }
  if (edge.includes("n")) {
    h = clamp(start.h - dy, minSize.h, maxSize?.h ?? Infinity);
    y = start.y + (start.h - h);
  }

  return { x, y, w, h };
}
