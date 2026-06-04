import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";

// A gradual blur + tint that fades content into a scroll container's edge,
// shown only when there's more to scroll in that direction. Used by the chat
// history, the message window (top/bottom), and inline request previews
// (left/right). One implementation, reused everywhere.

export type ScrollFadeEdge = "top" | "bottom" | "left" | "right";

const SCROLL_END_THRESHOLD_PX = 4;

// Direction the content fades toward the edge (solid at the edge, transparent away).
const FADE_DIRECTION: Record<ScrollFadeEdge, string> = {
  top: "to bottom",
  bottom: "to top",
  left: "to right",
  right: "to left",
};

const EDGE_POSITION: Record<ScrollFadeEdge, string> = {
  top: "inset-x-0 top-0 h-8",
  bottom: "inset-x-0 bottom-0 h-8",
  left: "inset-y-0 left-0 w-8",
  right: "inset-y-0 right-0 w-8",
};

// Static tint gradients (Tailwind can't see interpolated class names, so each
// tone/edge pair is spelled out). "panel" matches the assistant background;
// "code" matches the charcoal request-preview surface.
const TINT_GRADIENT: Record<"panel" | "code", Record<ScrollFadeEdge, string>> = {
  panel: {
    top: "bg-gradient-to-b from-background-bright/35 via-background-bright/8 to-transparent",
    bottom: "bg-gradient-to-t from-background-bright/35 via-background-bright/8 to-transparent",
    left: "bg-gradient-to-r from-background-bright/35 via-background-bright/8 to-transparent",
    right: "bg-gradient-to-l from-background-bright/35 via-background-bright/8 to-transparent",
  },
  code: {
    top: "bg-gradient-to-b from-charcoal-800 via-charcoal-800/60 to-transparent",
    bottom: "bg-gradient-to-t from-charcoal-800 via-charcoal-800/60 to-transparent",
    left: "bg-gradient-to-r from-charcoal-800 via-charcoal-800/60 to-transparent",
    right: "bg-gradient-to-l from-charcoal-800 via-charcoal-800/60 to-transparent",
  },
};

function blurLayers(edge: ScrollFadeEdge): { blur: string; mask: string }[] {
  const dir = FADE_DIRECTION[edge];
  return [
    { blur: "backdrop-blur-[2px]", mask: `linear-gradient(${dir}, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.12) 50%, transparent 100%)` },
    { blur: "backdrop-blur-[6px]", mask: `linear-gradient(${dir}, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.2) 45%, transparent 100%)` },
    { blur: "backdrop-blur-[14px]", mask: `linear-gradient(${dir}, black 0%, rgba(0,0,0,0.35) 40%, transparent 100%)` },
  ];
}

export function ScrollEdgeFade({
  edge,
  visible,
  tone = "panel",
}: {
  edge: ScrollFadeEdge;
  visible: boolean;
  tone?: "panel" | "code";
}) {
  const dir = FADE_DIRECTION[edge];
  const tintMask = `linear-gradient(${dir}, black 0%, transparent 72%)`;

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10 transition-opacity duration-300",
        EDGE_POSITION[edge],
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      {blurLayers(edge).map((layer) => (
        <div
          key={layer.blur}
          className={cn("absolute inset-0", layer.blur)}
          style={{ WebkitMaskImage: layer.mask, maskImage: layer.mask }}
        />
      ))}
      <div
        className={cn("absolute inset-0", TINT_GRADIENT[tone][edge])}
        style={{ WebkitMaskImage: tintMask, maskImage: tintMask }}
      />
    </div>
  );
}

interface ScrollFadeState {
  start: boolean;
  end: boolean;
}

function measureScrollFades(el: HTMLElement, axis: "vertical" | "horizontal"): ScrollFadeState {
  if (axis === "horizontal") {
    const canScroll = el.scrollWidth > el.clientWidth + 1;
    const atStart = el.scrollLeft <= SCROLL_END_THRESHOLD_PX;
    const atEnd = el.scrollWidth - el.scrollLeft - el.clientWidth <= SCROLL_END_THRESHOLD_PX;
    return { start: canScroll && !atStart, end: canScroll && !atEnd };
  }
  const canScroll = el.scrollHeight > el.clientHeight + 1;
  const atStart = el.scrollTop <= SCROLL_END_THRESHOLD_PX;
  const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_END_THRESHOLD_PX;
  return { start: canScroll && !atStart, end: canScroll && !atEnd };
}

// Tracks whether each edge of a scroll container has more content. Wire `ref`
// to the scrollable element and `onScroll` to its onScroll handler; remeasures
// on resize and whenever `deps` change. `start` = top/left, `end` = bottom/right.
export function useScrollFades({
  axis,
  enabled = true,
  deps = [],
}: {
  axis: "vertical" | "horizontal";
  enabled?: boolean;
  deps?: unknown[];
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [fades, setFades] = useState<ScrollFadeState>({ start: false, end: false });

  const measure = useCallback(() => {
    const el = elementRef.current;
    if (!el || !enabled) {
      setFades({ start: false, end: false });
      return;
    }
    setFades(measureScrollFades(el, axis));
  }, [axis, enabled]);

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      elementRef.current = node;
      if (node && enabled) setFades(measureScrollFades(node, axis));
    },
    [axis, enabled]
  );

  useLayoutEffect(() => {
    if (!enabled) {
      setFades({ start: false, end: false });
      return;
    }
    measure();
    const el = elementRef.current;
    if (!el) return;

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Double rAF: let layout settle (fonts, async content) before measuring.
    const raf = requestAnimationFrame(() => requestAnimationFrame(measure));

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, measure, ...deps]);

  return { ref, onScroll: measure, fades };
}
