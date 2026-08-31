// Both class helpers apply to always-rendered wrappers, so switching display mode is a
// class change only and the open chat's transport, session and transcript survive it.
import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { motion, type PanInfo } from "framer-motion";
import {
  draggableResizeHandleClassName,
  useDraggableResizable,
  type PanHandlerProps,
  type ResizeEdge,
} from "~/components/primitives/DraggableResizable";
import {
  dockZoneForPoint,
  type DockZone,
  type Point,
  type Rect,
} from "~/components/primitives/draggableResizableMath";
import type { ChatOpenMode } from "~/utils/dashboardPreferences";
import { cn } from "~/utils/cn";

// Mark an element (e.g. a header button, or just its icon) with `data-agent-no-drag` so a
// pan starting on it never drags the window.
const NO_DRAG_SELECTOR = "[data-agent-no-drag]";

/** Spread onto the drag handle; `dragHandleClassName` already carries cursor/touch-action/select-none. */
export type FloatingDragProps = {
  dragHandleProps: Partial<PanHandlerProps>;
  dragHandleClassName: string;
};

export type DashboardAgentMode = ChatOpenMode;

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

/** The mode a chat starts in, and the mode a transient in-chat switch reverts to: the
 * account preference, defaulting to floating. */
export function initialAgentMode(preference: DashboardAgentMode | undefined): DashboardAgentMode {
  return preference ?? "floating";
}

/**
 * Owns the chat's mode state for `DashboardAgent`: starts from the account preference,
 * lets in-chat switches (toggle, drag-to-dock) apply transiently, and resets to the
 * preference on close or on leaving fullscreen. Extracted so this wiring — not just
 * `initialAgentMode` in isolation — is the exact code under test.
 */
export function useAgentPanelMode(modePreference: DashboardAgentMode | undefined) {
  const [mode, setMode] = useState<DashboardAgentMode>(() => initialAgentMode(modePreference));

  const changeMode = useCallback((next: DashboardAgentMode) => {
    setMode(next);
  }, []);

  // Any transient in-chat mode switch applied only until close; the next open starts
  // from the account preference again.
  const resetToPreference = useCallback(() => {
    setMode(initialAgentMode(modePreference));
  }, [modePreference]);

  // Pathname changes must drop fullscreen so the new page is visible, even when the
  // preference itself is fullscreen — the preference governs the next open, not
  // mid-session navigation. Any other transient mode (e.g. rightPanel) is left alone.
  const revertFullscreen = useCallback(() => {
    setMode((current) => {
      if (current !== "fullscreen") return current;
      const next = initialAgentMode(modePreference);
      return next === "fullscreen" ? "floating" : next;
    });
  }, [modePreference]);

  return { mode, changeMode, resetToPreference, revertFullscreen };
}

function agentTakeoverClassName(fullscreen: boolean): string {
  return fullscreen ? "absolute inset-0 z-10 flex flex-col bg-background-bright" : "h-full";
}

// `invisible` rather than `display: none`: only this preserves the computed layout, so
// scroll positions and measured widths survive.
export function agentHiddenContentClassName(fullscreen: boolean): string {
  return cn("h-full overflow-hidden", fullscreen && "invisible");
}

const DOCK_ZONE_LABEL: Record<DockZone, string> = {
  rightPanel: "Dock right",
  fullscreen: "Fullscreen",
};

/** Transparent hint over the drop target, portaled so panel overflow can't clip it. */
function DockZoneOverlay({ zone }: { zone: DockZone }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed z-50 flex items-center justify-center border-2 border-dashed border-text-link bg-background-dimmed/70 text-sm text-text-bright backdrop-blur-xs",
        zone === "rightPanel" ? "inset-y-0 right-0 w-[380px]" : "inset-0"
      )}
    >
      {DOCK_ZONE_LABEL[zone]}
    </div>,
    document.body
  );
}

/**
 * Owns the drag-vs-click filter, so the panel and the standalone story behave identically.
 * Fullscreen needs a `relative` ancestor for `agentTakeoverClassName`, supplied by the caller.
 * Always mounted as the sole wrapper of `children` across all three modes — the caller must
 * never branch its own tree around this component, or a mode switch remounts the chat.
 */
export function FloatingAgentWindow({
  mode,
  onRequestModeChange,
  children,
}: {
  mode: DashboardAgentMode;
  onRequestModeChange?: (mode: DashboardAgentMode) => void;
  children: (drag: FloatingDragProps) => React.ReactNode;
}) {
  const fullscreen = mode === "fullscreen";
  const docked = mode === "rightPanel";
  const initial = useMemo(() => initialFloatingRect(), []);
  const { style, dragHandleProps, resizeHandleProps, position, size, setRect } =
    useDraggableResizable({
      initial,
      minSize: FLOATING_MIN_SIZE,
      viewportPadding: FLOATING_MARGIN,
    });
  const [dragging, setDragging] = useState(false);
  const [dockZone, setDockZone] = useState<DockZone | null>(null);
  // onPan can arrive before onPanStart, so the no-drag check runs once, on whichever fires first.
  const gestureClassified = useRef(false);
  const ignoringGesture = useRef(false);
  // The rect as it stood before this gesture, so a zoned drop can restore it — dragHandleProps.onPan
  // (called below) has already folded the drop point's delta into the hook's own state by then.
  const preDragRect = useRef<Rect | null>(null);

  const classifyGesture = (event: PointerEvent) => {
    if (gestureClassified.current) return;
    gestureClassified.current = true;
    ignoringGesture.current = !!(event.target as HTMLElement | null)?.closest(NO_DRAG_SELECTOR);
  };

  // PanInfo.point is page coordinates; the dock zones compare against the viewport, so use the
  // pointer event's client coordinates instead.
  const zoneForClientPoint = (point: Point) =>
    dockZoneForPoint(point, { width: window.innerWidth, height: window.innerHeight });

  // Same shape as `dragHandleProps` below empty, so a mode with no drag doesn't change types.
  const filteredDragHandleProps: Partial<PanHandlerProps> =
    fullscreen || docked
      ? {}
      : {
          onPanStart: (event: PointerEvent, info: PanInfo) => {
            classifyGesture(event);
            if (ignoringGesture.current) return;
            preDragRect.current = { ...position, ...size };
            setDragging(true);
            dragHandleProps.onPanStart?.(event, info);
          },
          onPan: (event: PointerEvent, info: PanInfo) => {
            classifyGesture(event);
            if (ignoringGesture.current) return;
            // onPan can arrive before onPanStart, so both capture the pre-drag rect and flip dragging.
            if (!preDragRect.current) preDragRect.current = { ...position, ...size };
            setDragging(true);
            setDockZone(zoneForClientPoint({ x: event.clientX, y: event.clientY }));
            dragHandleProps.onPan?.(event, info);
          },
          onPanEnd: (event: PointerEvent, info: PanInfo) => {
            const wasIgnoring = ignoringGesture.current;
            gestureClassified.current = false;
            ignoringGesture.current = false;
            setDragging(false);
            setDockZone(null);
            const droppedZone = wasIgnoring
              ? null
              : zoneForClientPoint({ x: event.clientX, y: event.clientY });
            const rectBeforeDrag = preDragRect.current;
            preDragRect.current = null;
            if (droppedZone) {
              if (rectBeforeDrag) setRect(rectBeforeDrag);
              onRequestModeChange?.(droppedZone);
              return;
            }
            dragHandleProps.onPanEnd?.(event, info);
          },
        };

  // Same two-`div` shape in all three modes — only classes/style change — so switching `mode`
  // never unmounts `children`; only className/style differ.
  return (
    <>
      {dragging && dockZone && <DockZoneOverlay zone={dockZone} />}
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
    </>
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
