// Both class helpers apply to always-rendered wrappers, so switching display mode is a
// class change only and the open chat's transport, session and transcript survive it.
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { motion, type PanInfo } from "framer-motion";
import {
  draggableResizeHandleClassName,
  useDraggableResizable,
  type PanHandlerProps,
  type ResizeEdge,
} from "~/components/primitives/DraggableResizable";
import { cn } from "~/utils/cn";

// Mark an element (e.g. a header button, or just its icon) with `data-agent-no-drag` so a
// pan starting on it never drags the window.
const NO_DRAG_SELECTOR = "[data-agent-no-drag]";

/** Spread onto the drag handle; `dragHandleClassName` already carries cursor/touch-action/select-none. */
export type FloatingDragProps = {
  dragHandleProps: Partial<PanHandlerProps>;
  dragHandleClassName: string;
};

const AGENT_FULLSCREEN_STORAGE_KEY = "tdev:dashboard-agent:fullscreen";
const AGENT_MODE_STORAGE_KEY = "tdev:dashboard-agent:mode";

export type DashboardAgentMode = "floating" | "rightPanel" | "fullscreen";

// V1 floating window: FLOATING_WIDTH x FLOATING_HEIGHT, bottom-right, matching the
// gallery's own panel frame.
export const FLOATING_WIDTH = 380;
export const FLOATING_HEIGHT = 600;
export const FLOATING_MARGIN = 16;
export const FLOATING_MIN_SIZE = { w: 320, h: 360 };
const RESIZE_EDGES: ResizeEdge[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];

// A dropped key (not just `undefined`) doesn't reliably clear on every style-application
// layer, so docked/fullscreen explicitly resets every key the floating rect ever sets.
const CLEARED_FLOATING_STYLE: CSSProperties = {
  position: undefined,
  left: undefined,
  top: undefined,
  width: undefined,
  height: undefined,
};

export function initialFloatingRect() {
  if (typeof window === "undefined") {
    return { x: 0, y: 0, w: FLOATING_WIDTH, h: FLOATING_HEIGHT };
  }
  return {
    x: window.innerWidth - FLOATING_WIDTH - FLOATING_MARGIN,
    y: window.innerHeight - FLOATING_HEIGHT - FLOATING_MARGIN,
    w: FLOATING_WIDTH,
    h: FLOATING_HEIGHT,
  };
}

// Reads the old boolean key once, so a browser that only ever knew fullscreen keeps its
// choice after the upgrade to three modes.
export function readAgentMode(): DashboardAgentMode {
  if (typeof window === "undefined") return "floating";
  try {
    const stored = window.localStorage.getItem(AGENT_MODE_STORAGE_KEY);
    if (stored === "floating" || stored === "rightPanel" || stored === "fullscreen") return stored;
    return window.localStorage.getItem(AGENT_FULLSCREEN_STORAGE_KEY) === "true"
      ? "fullscreen"
      : "floating";
  } catch {
    return "floating";
  }
}

export function writeAgentMode(mode: DashboardAgentMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function agentTakeoverClassName(fullscreen: boolean): string {
  return fullscreen ? "absolute inset-0 z-10 flex flex-col bg-background-bright" : "h-full";
}

// `invisible` rather than `display: none`: only this preserves the computed layout, so
// scroll positions and measured widths survive.
export function agentHiddenContentClassName(fullscreen: boolean): string {
  return cn("h-full overflow-hidden", fullscreen && "invisible");
}

/**
 * Owns the drag-vs-click filter, so the panel and the standalone story behave identically.
 * Fullscreen needs a `relative` ancestor for `agentTakeoverClassName`, supplied by the caller.
 * Always mounted as the sole wrapper of `children` across all three modes — the caller must
 * never branch its own tree around this component, or a mode switch remounts the chat.
 */
export function FloatingAgentWindow({
  mode,
  children,
}: {
  mode: DashboardAgentMode;
  children: (drag: FloatingDragProps) => React.ReactNode;
}) {
  const fullscreen = mode === "fullscreen";
  const docked = mode === "rightPanel";
  const initial = useMemo(() => initialFloatingRect(), []);
  const { style, dragHandleProps, resizeHandleProps } = useDraggableResizable({
    initial,
    minSize: FLOATING_MIN_SIZE,
    viewportPadding: FLOATING_MARGIN,
  });
  const [dragging, setDragging] = useState(false);
  // onPan can arrive before onPanStart, so the no-drag check runs once, on whichever fires first.
  const gestureClassified = useRef(false);
  const ignoringGesture = useRef(false);

  const classifyGesture = (event: PointerEvent) => {
    if (gestureClassified.current) return;
    gestureClassified.current = true;
    ignoringGesture.current = !!(event.target as HTMLElement | null)?.closest(NO_DRAG_SELECTOR);
  };

  // Same shape as `dragHandleProps` below empty, so a mode with no drag doesn't change types.
  const filteredDragHandleProps: Partial<PanHandlerProps> =
    fullscreen || docked
      ? {}
      : {
          onPanStart: (event: PointerEvent, info: PanInfo) => {
            classifyGesture(event);
            if (ignoringGesture.current) return;
            setDragging(true);
            dragHandleProps.onPanStart?.(event, info);
          },
          onPan: (event: PointerEvent, info: PanInfo) => {
            classifyGesture(event);
            if (ignoringGesture.current) return;
            dragHandleProps.onPan?.(event, info);
          },
          onPanEnd: (event: PointerEvent, info: PanInfo) => {
            gestureClassified.current = false;
            ignoringGesture.current = false;
            setDragging(false);
            dragHandleProps.onPanEnd?.(event, info);
          },
        };

  // Same two-`div` shape in all three modes — only classes/style change — so switching `mode`
  // never unmounts `children`; only className/style differ.
  return (
    <div
      style={fullscreen || docked ? CLEARED_FLOATING_STYLE : style}
      className={
        fullscreen
          ? agentTakeoverClassName(true)
          : docked
            ? "flex h-full flex-col"
            : "z-30 flex flex-col rounded-lg border border-border-bright bg-background-bright shadow-2xl"
      }
    >
      {/* Clips content to the rounded corners without clipping the resize handles below,
          which sit half outside this box's edges. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          !fullscreen && !docked && "overflow-hidden rounded-lg"
        )}
      >
        {/* oxlint-disable-next-line react/refs -- the ref is only read inside event handlers, not during render. */}
        {children({
          dragHandleProps: filteredDragHandleProps,
          dragHandleClassName:
            fullscreen || docked
              ? ""
              : cn("select-none touch-none", dragging ? "cursor-grabbing" : "cursor-grab"),
        })}
      </div>
      {!fullscreen &&
        !docked &&
        RESIZE_EDGES.map((edge) => (
          <motion.div
            key={edge}
            {...resizeHandleProps(edge)}
            className={draggableResizeHandleClassName(edge)}
          />
        ))}
    </div>
  );
}

export function AgentPanelColumn({
  fullscreen,
  children,
}: {
  fullscreen: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        fullscreen && "mx-auto w-full max-w-3xl"
      )}
    >
      {children}
    </div>
  );
}
