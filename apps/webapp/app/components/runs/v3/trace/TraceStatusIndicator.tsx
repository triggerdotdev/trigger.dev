import { BoltSlashIcon, CheckIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { type TraceStatus } from "./traceStatus";

const ALL_LOADED_VISIBLE_MS = 4000;
const ALL_LOADED_FADE_MS = 500;

type AllLoadedPhase = "shown" | "fading" | "gone";

/** States after which "All spans loaded" is worth confirming. */
const TRANSITION_KINDS = new Set<TraceStatus["kind"]>(["loading", "live", "failed"]);

export function TraceStatusIndicator({
  status,
  onRetry,
}: {
  status: TraceStatus;
  onRetry: () => void;
}) {
  // Opening an already-loaded finished run shows nothing; only a change earns the confirmation.
  const [sawTransition, setSawTransition] = useState(false);
  if (!sawTransition && TRANSITION_KINDS.has(status.kind)) {
    setSawTransition(true);
  }

  switch (status.kind) {
    case "loading":
      return (
        <SimpleTooltip
          disableHoverableContent
          className="max-w-xs"
          content={status.reason}
          button={
            <StatusLabel className="text-text-dimmed">
              <Spinner className="size-3" />
              Loading spans…
            </StatusLabel>
          }
        />
      );
    case "live":
      return (
        <StatusLabel className="text-blue-500">
          <PulsingDot />
          Live
        </StatusLabel>
      );
    case "liveOff":
      return (
        <SimpleTooltip
          disableHoverableContent
          className="max-w-xs"
          content={status.reason}
          button={
            <StatusLabel className="text-text-dimmed">
              <BoltSlashIcon className="size-3.5" />
              Live updates off
            </StatusLabel>
          }
        />
      );
    case "partial":
      return (
        <SimpleTooltip
          disableHoverableContent
          className="max-w-xs"
          content={status.reason}
          button={
            <StatusLabel className="text-warning">
              <ExclamationTriangleIcon className="size-3.5" />
              Partial trace
            </StatusLabel>
          }
        />
      );
    case "failed":
      return (
        <SimpleTooltip
          content={
            <div className="max-w-xs p-1">
              <Paragraph variant="small" className="text-wrap! text-text-dimmed">
                {status.reason}
              </Paragraph>
              <Button variant="secondary/small" onClick={onRetry} className="mt-3">
                Retry failed load
              </Button>
            </div>
          }
          button={
            <StatusLabel className="text-warning">
              <ExclamationTriangleIcon className="size-3.5" />
              Couldn't load all spans
            </StatusLabel>
          }
        />
      );
    case "allLoaded":
      return sawTransition ? <AllLoadedStatus /> : null;
    default:
      return null;
  }
}

/** Mounted only while all spans are loaded, so each mount starts its own fade. */
function AllLoadedStatus() {
  const [phase, setPhase] = useState<AllLoadedPhase>("shown");

  useEffect(() => {
    const fade = setTimeout(() => setPhase("fading"), ALL_LOADED_VISIBLE_MS);
    const hide = setTimeout(() => setPhase("gone"), ALL_LOADED_VISIBLE_MS + ALL_LOADED_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(hide);
    };
  }, []);

  if (phase === "gone") return null;

  return (
    <StatusLabel
      className={cn("text-text-dimmed transition-opacity", phase === "fading" && "opacity-0")}
      style={{ transitionDuration: `${ALL_LOADED_FADE_MS}ms` }}
    >
      <CheckIcon className="size-3.5 text-success" />
      All spans loaded
    </StatusLabel>
  );
}

function StatusLabel({
  className,
  style,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("flex items-center gap-1.5 whitespace-nowrap text-xs", className)}
      style={style}
    >
      {children}
    </div>
  );
}

function PulsingDot() {
  return (
    <span className="relative flex size-2">
      <span
        className={`absolute h-full w-full animate-ping rounded-full border border-blue-500 opacity-100 duration-1000`}
      />
      <span className={`size-2 rounded-full bg-blue-500`} />
    </span>
  );
}
