import { useRef, useState } from "react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";

/** Cut short anywhere: an ellipsis on the environment or id, or the line clipped whole. */
function isCutShort(banner: HTMLElement | null) {
  if (!banner) return false;
  return [banner, ...banner.children].some((node) => node.scrollWidth > node.clientWidth);
}

export function DashboardAgentContextBanner({
  projectName,
  environmentSlug,
  entityId,
  className,
}: {
  projectName: string;
  environmentSlug: string;
  /** The entity a detail page is about; absent on lists and overviews. */
  entityId?: string;
  className?: string;
}) {
  const path = entityId
    ? `${projectName} / ${environmentSlug} / ${entityId}`
    : `${projectName} / ${environmentSlug}`;
  const ref = useRef<HTMLDivElement>(null);
  const [showPath, setShowPath] = useState(false);
  return (
    <SimpleTooltip
      asChild
      // Measured when the delay has run, not on every resize: by then the layout is settled,
      // and a path that fits never gets a tooltip repeating it.
      open={showPath}
      onOpenChange={(open) => setShowPath(open && isCutShort(ref.current))}
      delayDuration={500}
      disableHoverableContent
      content={path}
      className="max-w-sm wrap-anywhere"
      button={
        <div
          ref={ref}
          className={cn(
            "flex w-fit items-center gap-1 text-xs text-text-dimmed",
            // Without `min-w-0` flexbox holds this at its content width and pushes whatever
            // shares the row out of view. `truncate` is the last resort: it clips the banner
            // whole when even the name doesn't fit.
            "min-w-0 max-w-full truncate",
            className
          )}
        >
          <span className="shrink-0">Context:</span>
          {/* The name stays whole. The id gives up its room first, and only then does a long
              environment, each with an ellipsis. Shrink is shared by weight, and even a sliver of
              a pixel puts an ellipsis on "prod", so the id's weight leaves the environment none. */}
          <span className="shrink-0">{projectName}</span>
          <span className="shrink-0">/</span>
          <span className="min-w-0 truncate">{environmentSlug}</span>
          {/* The slash goes with the id, so an id squeezed to nothing leaves no separator behind. */}
          {entityId ? (
            <span className="min-w-0 shrink-[1000000] truncate">/ {entityId}</span>
          ) : null}
        </div>
      }
    />
  );
}
