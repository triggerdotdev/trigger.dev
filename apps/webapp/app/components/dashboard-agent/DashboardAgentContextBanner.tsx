import { cn } from "~/utils/cn";

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
  return (
    <div
      className={cn(
        "flex h-5 w-fit items-center gap-1 rounded border border-grid-bright bg-background-bright px-1.5 text-xs text-text-dimmed",
        // Without `min-w-0` flexbox holds this at its content width and pushes whatever
        // shares the row out of view. `truncate` is the last resort: it clips the banner
        // whole when even the name and environment don't fit.
        "min-w-0 max-w-full truncate",
        className
      )}
      title={path}
    >
      <span className="shrink-0">Context:</span>
      {/* Name and environment stay whole; only the id gives up room. */}
      <span className="shrink-0 font-medium text-text-bright">{projectName}</span>
      <span className="shrink-0">/</span>
      <span className="shrink-0">{environmentSlug}</span>
      {entityId ? (
        <>
          <span className="shrink-0">/</span>
          <span className="min-w-0 truncate">{entityId}</span>
        </>
      ) : null}
    </div>
  );
}
