interface AIChatContextBannerProps {
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
}

export function AIChatContextBanner({
  projectSlug,
  environmentSlug,
  currentPage,
}: AIChatContextBannerProps) {
  if (!projectSlug) return null;

  return (
    <div className="flex items-center gap-1.5 border-b border-grid-bright bg-charcoal-800/30 px-3 py-1.5 text-xs text-text-dimmed">
      <span className="font-medium text-text-bright">{projectSlug}</span>
      <span>/</span>
      <span>{environmentSlug}</span>
      <span>/</span>
      <span className="capitalize">{currentPage}</span>
    </div>
  );
}