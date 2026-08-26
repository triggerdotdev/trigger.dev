// Both class helpers apply to always-rendered wrappers, so toggling fullscreen is a
// class change only and the open chat's transport, session and transcript survive it.
import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  useDraggableResizable,
  type PanHandlerProps,
  type ResizeEdge,
} from "~/components/primitives/DraggableResizable";
import { cn } from "~/utils/cn";

const AGENT_FULLSCREEN_STORAGE_KEY = "tdev:dashboard-agent:fullscreen";

// V1 floating window: 380x512, bottom-right, matching the gallery's own panel frame.
const FLOATING_WIDTH = 380;
const FLOATING_HEIGHT = 512;
const FLOATING_MARGIN = 16;
const FLOATING_MIN_SIZE = { w: 320, h: 360 };
const RESIZE_EDGES: ResizeEdge[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];

const RESIZE_HANDLE_CLASS: Record<ResizeEdge, string> = {
  n: "absolute inset-x-2 top-0 h-1.5 cursor-n-resize",
  s: "absolute inset-x-2 bottom-0 h-1.5 cursor-s-resize",
  e: "absolute inset-y-2 right-0 w-1.5 cursor-e-resize",
  w: "absolute inset-y-2 left-0 w-1.5 cursor-w-resize",
  ne: "absolute right-0 top-0 size-3 cursor-ne-resize",
  nw: "absolute left-0 top-0 size-3 cursor-nw-resize",
  se: "absolute right-0 bottom-0 size-3 cursor-se-resize",
  sw: "absolute left-0 bottom-0 size-3 cursor-sw-resize",
};

function initialFloatingRect() {
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

export function readAgentFullscreen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AGENT_FULLSCREEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAgentFullscreen(fullscreen: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_FULLSCREEN_STORAGE_KEY, fullscreen ? "true" : "false");
  } catch {
    /* ignore */
  }
}

function agentTakeoverClassName(fullscreen: boolean): string {
  return fullscreen ? "absolute inset-0 z-10 bg-background-bright" : "h-full";
}

// `invisible` rather than `display: none`: only this preserves the computed layout, so
// scroll positions and measured widths survive.
export function agentHiddenContentClassName(fullscreen: boolean): string {
  return cn("h-full overflow-hidden", fullscreen && "invisible");
}

/**
 * The floating chat window: `useDraggableResizable`-positioned bottom-right, draggable
 * and resizable across the whole page. Fullscreen swaps it back to the same takeover the
 * old right-column mode used, which needs `children` positioned inside a `relative`
 * ancestor — the caller (`DashboardAgent`) supplies that.
 */
export function FloatingAgentWindow({
  fullscreen,
  children,
}: {
  fullscreen: boolean;
  children: (dragHandleProps: Partial<PanHandlerProps>) => React.ReactNode;
}) {
  const initial = useMemo(() => initialFloatingRect(), []);
  const { style, dragHandleProps, resizeHandleProps } = useDraggableResizable({
    initial,
    minSize: FLOATING_MIN_SIZE,
    viewportPadding: FLOATING_MARGIN,
  });

  if (fullscreen) {
    return <div className={agentTakeoverClassName(true)}>{children({})}</div>;
  }

  return (
    <div
      style={style}
      className="z-20 flex flex-col overflow-hidden rounded-lg border border-border-bright bg-background-bright shadow-2xl"
    >
      {children(dragHandleProps)}
      {RESIZE_EDGES.map((edge) => (
        <motion.div key={edge} {...resizeHandleProps(edge)} className={RESIZE_HANDLE_CLASS[edge]} />
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
