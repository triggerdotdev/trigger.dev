export function DashboardAgentContextBanner({
  projectSlug,
  environmentSlug,
  currentPage,
}: {
  projectSlug: string;
  environmentSlug: string;
  // A human label for the page ("Runs", "Run detail"), not a path — see
  // `page-label.ts`. The agent still receives the full pathname separately.
  currentPage: string;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-grid-bright bg-background-bright/30 px-3 py-1.5 text-xs text-text-dimmed">
      <span className="shrink-0">Context:</span>
      <span className="truncate font-medium text-text-bright">{projectSlug}</span>
      <span>/</span>
      <span className="truncate">{environmentSlug}</span>
      <span>/</span>
      <span className="truncate">{currentPage}</span>
    </div>
  );
}
