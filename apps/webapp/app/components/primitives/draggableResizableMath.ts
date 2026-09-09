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

/** Below this the window has no room for its own header and edge controls. */
export const ABSOLUTE_MIN_SIZE: Size = { w: 120, h: 120 };

/**
 * `minSize` is a preference, not a guarantee: on a viewport too small to hold it the box
 * would otherwise overflow and push its resize edges off-screen. It gives way to the
 * viewport, down to {@link ABSOLUTE_MIN_SIZE}.
 */
export function effectiveMinSize(minSize: Size, viewport: Viewport, padding: number): Size {
  // Only ever lowers `minSize`: a caller asking for less than the absolute floor still
  // gets what it asked for.
  return {
    w: Math.min(minSize.w, Math.max(ABSOLUTE_MIN_SIZE.w, viewport.width - 2 * padding)),
    h: Math.min(minSize.h, Math.max(ABSOLUTE_MIN_SIZE.h, viewport.height - 2 * padding)),
  };
}

/** Shrinks a box to what the viewport can hold, never below the effective min. */
function clampSizeToViewport(size: Size, viewport: Viewport, padding: number, minSize: Size): Size {
  const min = effectiveMinSize(minSize, viewport, padding);
  return {
    w: Math.min(size.w, Math.max(min.w, viewport.width - 2 * padding)),
    h: Math.min(size.h, Math.max(min.h, viewport.height - 2 * padding)),
  };
}

// Size first: a box wider than the viewport can't be positioned into it, so clamping
// position against the un-shrunk size would strand it off-screen.
export function clampRectToViewport(
  rect: Rect,
  viewport: Viewport,
  padding: number,
  minSize: Size
): Rect {
  const size = clampSizeToViewport({ w: rect.w, h: rect.h }, viewport, padding, minSize);
  const position = clampPosition({ x: rect.x, y: rect.y }, size, viewport, padding);
  return { ...position, ...size };
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

  // The same floor the viewport clamp uses, so a gesture can't grow the box past a
  // viewport that is itself smaller than `minSize`.
  const min = effectiveMinSize(minSize, viewport, padding);

  if (edge.includes("e")) {
    const maxW = Math.max(
      min.w,
      Math.min(maxSize?.w ?? Infinity, viewport.width - padding - start.x)
    );
    w = clamp(start.w + dx, min.w, maxW);
  }
  if (edge.includes("s")) {
    const maxH = Math.max(
      min.h,
      Math.min(maxSize?.h ?? Infinity, viewport.height - padding - start.y)
    );
    h = clamp(start.h + dy, min.h, maxH);
  }
  if (edge.includes("w")) {
    const maxW = Math.max(min.w, Math.min(maxSize?.w ?? Infinity, start.x + start.w - padding));
    w = clamp(start.w - dx, min.w, maxW);
    x = start.x + (start.w - w);
  }
  if (edge.includes("n")) {
    const maxH = Math.max(min.h, Math.min(maxSize?.h ?? Infinity, start.y + start.h - padding));
    h = clamp(start.h - dy, min.h, maxH);
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

export type DockZone = "rightPanel" | "fullscreen";

const DOCK_ZONE_SIZE = 48;

/** Right edge wins the top-right corner, matching which hint the overlay shows there. */
export function dockZoneForPoint(
  point: Point,
  viewport: Viewport,
  zoneSize = DOCK_ZONE_SIZE
): DockZone | null {
  if (point.x >= viewport.width - zoneSize) return "rightPanel";
  if (point.y <= zoneSize) return "fullscreen";
  return null;
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
  return clampRectToViewport(resized, viewport, padding, minSize);
}
