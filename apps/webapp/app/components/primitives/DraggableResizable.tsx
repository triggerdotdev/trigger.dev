import { useEffect, useState, type CSSProperties } from "react";
import { type PanInfo } from "framer-motion";
import { cn } from "~/utils/cn";
import {
  applyDragDelta,
  applyResizeDelta,
  clampPosition,
  clampRectToViewport,
  clampSize,
  type Point,
  type Rect,
  type ResizeEdge,
  type Size,
  type Viewport,
} from "./draggableResizableMath";

export type { ResizeEdge } from "./draggableResizableMath";

export type UseDraggableResizableOptions = {
  initial: Rect;
  minSize: Size;
  maxSize?: Size;
  /** Minimum distance kept from the viewport edges. Defaults to 8px. */
  viewportPadding?: number;
};

/** Spread onto a framer-motion `motion.div` — drag/resize tracking rides on its pan gesture. */
export type PanHandlerProps = {
  onPanStart: (event: PointerEvent, info: PanInfo) => void;
  onPan: (event: PointerEvent, info: PanInfo) => void;
  onPanEnd: (event: PointerEvent, info: PanInfo) => void;
};

export type UseDraggableResizableResult = {
  /**
   * position:fixed with left/top/width/height set from state. `x`/`y` are the
   * top-left corner in viewport coordinates — if the window docks bottom-right,
   * derive the initial x/y from `window.innerWidth/innerHeight - w/h - padding`.
   */
  style: CSSProperties;
  dragHandleProps: PanHandlerProps;
  resizeHandleProps: (edge: ResizeEdge) => PanHandlerProps;
  position: Point;
  size: Size;
};

function getViewport(): Viewport {
  // SSR: no window. Report an unbounded viewport so the initial clamp is a no-op;
  // the mount-time effect below re-clamps against the real viewport once hydrated.
  if (typeof window === "undefined") {
    return { width: Infinity, height: Infinity };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useDraggableResizable({
  initial,
  minSize,
  maxSize,
  viewportPadding = 8,
}: UseDraggableResizableOptions): UseDraggableResizableResult {
  const [rect, setRect] = useState<Rect>(() => {
    const size = clampSize({ w: initial.w, h: initial.h }, minSize, maxSize);
    return { ...clampPosition(initial, size, getViewport(), viewportPadding), ...size };
  });

  // Re-clamp on viewport resize (and once on mount, since SSR renders against
  // an unbounded viewport) so the box never strands off-screen.
  useEffect(() => {
    const onResize = () => {
      setRect((current) => clampRectToViewport(current, getViewport(), viewportPadding));
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [viewportPadding]);

  // Each onPan step folds `info.delta` onto the latest committed rect via functional
  // setState, with no gesture-start baseline kept: framer-motion can deliver onPan before
  // onPanStart (its scheduler defers onPanStart by a frame), which would make a ref-based
  // baseline stale.
  const dragHandleProps: PanHandlerProps = {
    onPanStart: () => {},
    onPan: (_event, info: PanInfo) => {
      setRect((current) => applyDragDelta(current, info.delta, getViewport(), viewportPadding));
    },
    onPanEnd: () => {},
  };

  const resizeHandleProps = (edge: ResizeEdge): PanHandlerProps => ({
    onPanStart: () => {},
    onPan: (_event, info: PanInfo) => {
      setRect((current) =>
        applyResizeDelta(
          edge,
          current,
          info.delta,
          minSize,
          maxSize,
          getViewport(),
          viewportPadding
        )
      );
    },
    onPanEnd: () => {},
  });

  return {
    style: {
      position: "fixed",
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
    },
    dragHandleProps,
    resizeHandleProps,
    position: { x: rect.x, y: rect.y },
    size: { w: rect.w, h: rect.h },
  };
}

const EDGE_CURSOR: Record<ResizeEdge, string> = {
  n: "cursor-ns-resize",
  s: "cursor-ns-resize",
  e: "cursor-ew-resize",
  w: "cursor-ew-resize",
  ne: "cursor-nesw-resize",
  sw: "cursor-nesw-resize",
  nw: "cursor-nwse-resize",
  se: "cursor-nwse-resize",
};

const EDGE_POSITION: Record<ResizeEdge, string> = {
  n: "inset-x-0 top-0 h-1.5 -translate-y-1/2",
  s: "inset-x-0 bottom-0 h-1.5 translate-y-1/2",
  e: "inset-y-0 right-0 w-1.5 translate-x-1/2",
  w: "inset-y-0 left-0 w-1.5 -translate-x-1/2",
  ne: "right-0 top-0 h-3 w-3 translate-x-1/2 -translate-y-1/2",
  nw: "left-0 top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2",
  se: "right-0 bottom-0 h-3 w-3 translate-x-1/2 translate-y-1/2",
  sw: "left-0 bottom-0 h-3 w-3 -translate-x-1/2 translate-y-1/2",
};

/** Thin hit area for one resize edge/corner, styled to match ResizableHandle. Spread `resizeHandleProps(edge)` onto it. */
export function draggableResizeHandleClassName(edge: ResizeEdge, className?: string) {
  return cn(
    "absolute z-10 touch-none select-none",
    EDGE_CURSOR[edge],
    EDGE_POSITION[edge],
    className
  );
}
