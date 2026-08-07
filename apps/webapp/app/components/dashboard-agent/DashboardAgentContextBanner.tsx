import { cn } from "~/utils/cn";

export function DashboardAgentContextBanner({
  projectSlug,
  environmentSlug,
  currentPage,
  className,
}: {
  projectSlug: string;
  environmentSlug: string;
  // A human label from `page-label.ts`, not a path.
  currentPage: string;
  className?: string;
}) {
  const path = `${projectSlug} / ${environmentSlug} / ${currentPage}`;
  return (
    <div
      className={cn(
        "flex h-5 w-fit max-w-full items-center gap-1 rounded border border-grid-bright bg-background-bright px-1.5 text-xs text-text-dimmed",
        className
      )}
      title={`Answering in the context of ${path}`}
    >
      <span className="shrink-0">Context:</span>
      <span className="truncate font-medium text-text-bright">{projectSlug}</span>
      <span className="shrink-0">/</span>
      <span className="truncate">{environmentSlug}</span>
      <span className="shrink-0">/</span>
      <span className="truncate">{currentPage}</span>
    </div>
  );
}
