import {
  Component,
  ComponentPropsWithoutRef,
  Fragment,
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { inverseLerp, lerp } from "~/utils/lerp";

interface MousePosition {
  x: number;
  y: number;
}
const MousePositionContext = createContext<MousePosition | undefined>(undefined);
export function MousePositionProvider({
  children,
  recalculateTrigger,
}: {
  children: ReactNode;
  recalculateTrigger?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MousePosition | undefined>(undefined);
  const lastMouseCoordsRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      lastMouseCoordsRef.current = { clientX: e.clientX, clientY: e.clientY };

      if (!ref.current) {
        setPosition(undefined);
        return;
      }

      const { top, left, width, height } = ref.current.getBoundingClientRect();
      const x = (e.clientX - left) / width;
      const y = (e.clientY - top) / height;

      if (x < 0 || x > 1 || y < 0 || y > 1) {
        setPosition(undefined);
        return;
      }

      setPosition({ x, y });
    },
    [ref.current]
  );

  // Recalculate position when trigger changes (e.g., panel opens/closes)
  // Use requestAnimationFrame to wait for the DOM layout to complete
  useEffect(() => {
    if (!lastMouseCoordsRef.current) {
      return;
    }

    const rafId = requestAnimationFrame(() => {
      if (!ref.current || !lastMouseCoordsRef.current) {
        return;
      }

      const { top, left, width, height } = ref.current.getBoundingClientRect();
      const x = (lastMouseCoordsRef.current.clientX - left) / width;
      const y = (lastMouseCoordsRef.current.clientY - top) / height;

      if (x < 0 || x > 1 || y < 0 || y > 1) {
        setPosition(undefined);
        return;
      }

      setPosition({ x, y });
    });

    return () => cancelAnimationFrame(rafId);
  }, [recalculateTrigger]);

  return (
    <div
      ref={ref}
      onMouseEnter={handleMouseMove}
      onMouseLeave={() => {
        lastMouseCoordsRef.current = null;
        setPosition(undefined);
      }}
      onMouseMove={handleMouseMove}
      style={{ width: "100%", height: "100%" }}
    >
      <MousePositionContext.Provider value={position}>{children}</MousePositionContext.Provider>
    </div>
  );
}
export const useMousePosition = () => {
  return useContext(MousePositionContext);
};

type TimelineContextState = {
  startMs: number;
  durationMs: number;
};
const TimelineContext = createContext<TimelineContextState>({} as TimelineContextState);

function useTimeline() {
  return useContext(TimelineContext);
}

type TimelineMousePositionContextState = { x: number; y: number } | undefined;
const TimelineMousePositionContext = createContext<TimelineMousePositionContextState>(undefined);
function useTimelineMousePosition() {
  return useContext(TimelineMousePositionContext);
}

export type RootProps = {
  /** If the timeline doesn't start at zero. Doesn't impact layout but gives you the times back */
  startMs?: number;
  durationMs: number;
  /** A number between 0 and 1, determines the width between min and max */
  scale: number;
  minWidth: number;
  maxWidth: number;
  children?: ReactNode;
  className?: string;
  /** When this value changes, recalculate the mouse position (useful when panels resize) */
  recalculateTrigger?: unknown;
};

/** The main element that determines the dimensions for all sub-elements */
export function Root({
  startMs = 0,
  durationMs,
  scale,
  minWidth,
  maxWidth,
  children,
  className,
  recalculateTrigger,
}: RootProps) {
  const pixelWidth = calculatePixelWidth(minWidth, maxWidth, scale);

  return (
    <TimelineContext.Provider value={{ startMs, durationMs }}>
      <div
        className={className}
        style={{
          position: "relative",
          width: `${pixelWidth}px`,
        }}
      >
        <MousePositionProvider recalculateTrigger={recalculateTrigger}>
          {children}
        </MousePositionProvider>
      </div>
    </TimelineContext.Provider>
  );
}

export type RowProps = ComponentPropsWithoutRef<"div">;

/** This simply acts as a container, with position relative.
 *  This allows you to nest "Rows" and put heights on them */
export function Row({ className, children, ...props }: RowProps) {
  return (
    <div {...props} className={className} style={{ ...props.style, position: "relative" }}>
      {children}
    </div>
  );
}

export type PointProps = {
  ms: number;
  className?: string;
  children?: (ms: number) => ReactNode;
};

/** A point in time, it has no duration */
export function Point({ ms, className, children }: PointProps) {
  const { startMs, durationMs } = useTimeline();
  const position = inverseLerp(startMs, startMs + durationMs, ms);
  return (
    <div
      className={className}
      style={{
        position: "absolute",
        left: `${position * 100}%`,
      }}
    >
      {children && children(ms)}
    </div>
  );
}

export type SpanProps = {
  startMs: number;
  durationMs: number;
  className?: string;
  children?: ReactNode;
};

/** As span of time with a start and duration */
export function Span({ startMs, durationMs, className, children }: SpanProps) {
  const { startMs: rootStartMs, durationMs: rootDurationMs } = useTimeline();
  const position = inverseLerp(rootStartMs, rootStartMs + rootDurationMs, startMs);
  const width =
    inverseLerp(rootStartMs, rootStartMs + rootDurationMs, startMs + durationMs) - position;
  return (
    <div
      className={className}
      style={{
        position: "absolute",
        left: `${position * 100}%`,
        width: `${width * 100}%`,
      }}
    >
      {children}
    </div>
  );
}

export type EquallyDistributeProps = {
  count: number;
  children: (ms: number, index: number) => ReactNode;
};

/** Render a child equally distributed across the duration */
export function EquallyDistribute({ count, children }: EquallyDistributeProps) {
  const { startMs, durationMs } = useTimeline();

  return (
    <>
      {Array.from({ length: count }).map((_, index) => {
        const ms = startMs + (durationMs / (count - 1)) * index;
        return <Fragment key={index}>{children(ms, index)}</Fragment>;
      })}
    </>
  );
}

export type FollowCursorProps = {
  children: (ms: number) => ReactNode;
};

/** Renders a child that follows the cursor */
export function FollowCursor({ children }: FollowCursorProps) {
  const { startMs, durationMs } = useTimeline();
  const relativeMousePosition = useMousePosition();
  const ms = relativeMousePosition?.x
    ? lerp(startMs, startMs + durationMs, relativeMousePosition.x)
    : undefined;

  if (ms === undefined) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: relativeMousePosition ? `${relativeMousePosition?.x * 100}%` : 0,
        height: "100%",
        pointerEvents: "none",
      }}
    >
      {children(ms)}
    </div>
  );
}

/** Gives the total width of the root */
function calculatePixelWidth(minWidth: number, maxWidth: number, scale: number) {
  return lerp(minWidth, maxWidth, scale);
}
