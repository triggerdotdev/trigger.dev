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

// North/west edges move the opposite corner too, so the cap is derived from the fixed far
// edge and growth can't push it past the viewport padding.
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

  // `minSize` wins over the viewport cap: a tiny viewport must not shrink the box
  // below its minimum, so every per-edge cap is floored at the matching min dimension.
  if (edge.includes("e")) {
    const maxW = Math.max(
      minSize.w,
      Math.min(maxSize?.w ?? Infinity, viewport.width - padding - start.x)
    );
    w = clamp(start.w + dx, minSize.w, maxW);
  }
  if (edge.includes("s")) {
    const maxH = Math.max(
      minSize.h,
      Math.min(maxSize?.h ?? Infinity, viewport.height - padding - start.y)
    );
    h = clamp(start.h + dy, minSize.h, maxH);
  }
  if (edge.includes("w")) {
    const maxW = Math.max(minSize.w, Math.min(maxSize?.w ?? Infinity, start.x + start.w - padding));
    w = clamp(start.w - dx, minSize.w, maxW);
    x = start.x + (start.w - w);
  }
  if (edge.includes("n")) {
    const maxH = Math.max(minSize.h, Math.min(maxSize?.h ?? Infinity, start.y + start.h - padding));
    h = clamp(start.h - dy, minSize.h, maxH);
    y = start.y + (start.h - h);
  }

  return { x, y, w, h };
}

// Incremental (framer's per-event `delta`), not start-snapshot-based, since onPan can
// arrive before onPanStart and leave a snapshot baseline stale.
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
