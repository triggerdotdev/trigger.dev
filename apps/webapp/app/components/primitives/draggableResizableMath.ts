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
 * Applies a pointer delta to `start` for the given resize edge, respecting min/max size
 * and the viewport bounds. North/west edges move the opposite corner too so the far edge
 * stays put — the per-edge cap is derived from the *fixed* far edge, so growth can never
 * push it past the viewport padding.
 */
export function resizeRect(
  edge: ResizeEdge,
  start: Rect,
  dx: number,
  dy: number,
  minSize: Size,
  maxSize: Size | undefined,
  viewport: Viewport,
  padding: number
): Rect {
  let { x, y, w, h } = start;

  if (edge.includes("e")) {
    const maxW = Math.min(maxSize?.w ?? Infinity, viewport.width - padding - start.x);
    w = clamp(start.w + dx, minSize.w, maxW);
  }
  if (edge.includes("s")) {
    const maxH = Math.min(maxSize?.h ?? Infinity, viewport.height - padding - start.y);
    h = clamp(start.h + dy, minSize.h, maxH);
  }
  if (edge.includes("w")) {
    const maxW = Math.min(maxSize?.w ?? Infinity, start.x + start.w - padding);
    w = clamp(start.w - dx, minSize.w, maxW);
    x = start.x + (start.w - w);
  }
  if (edge.includes("n")) {
    const maxH = Math.min(maxSize?.h ?? Infinity, start.y + start.h - padding);
    h = clamp(start.h - dy, minSize.h, maxH);
    y = start.y + (start.h - h);
  }

  return { x, y, w, h };
}

/**
 * Applies one incremental pan step (framer-motion's `PanInfo.delta` — the movement since
 * the *previous* event, not cumulative from gesture start) to `current` and re-clamps.
 *
 * Deliberately incremental rather than start-snapshot + cumulative-offset: framer-motion
 * defers `onPanStart`/`onPanEnd` by a frame (via its internal scheduler) while `onPan`
 * fires synchronously, so a start-rect ref captured in `onPanStart` can still hold a
 * stale (or the mount-time initial) value when the gesture's first `onPan` lands — every
 * later step then computes off the wrong baseline. Folding each step onto `current`
 * (always the latest committed rect, via React's functional `setState`) has no baseline
 * to go stale, so the race can't happen. Safe to call across gesture boundaries with no
 * reset in between — each call is self-contained.
 */
export function applyDragDelta(
  current: Rect,
  delta: Point,
  viewport: Viewport,
  padding: number
): Rect {
  const nextPosition = clampPosition(
    { x: current.x + delta.x, y: current.y + delta.y },
    { w: current.w, h: current.h },
    viewport,
    padding
  );
  return { ...current, ...nextPosition };
}

/** Resize counterpart of {@link applyDragDelta} — same incremental-step rationale. */
export function applyResizeDelta(
  edge: ResizeEdge,
  current: Rect,
  delta: Point,
  minSize: Size,
  maxSize: Size | undefined,
  viewport: Viewport,
  padding: number
): Rect {
  const resized = resizeRect(edge, current, delta.x, delta.y, minSize, maxSize, viewport, padding);
  return clampRectToViewport(resized, viewport, padding);
}
