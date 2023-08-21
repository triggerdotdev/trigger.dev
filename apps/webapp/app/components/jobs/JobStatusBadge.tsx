import { cn } from "~/utils/cn";

type JobStatusBadgeProps = {
  enabled: boolean;
  hasIntegrationsRequiringAction: boolean;
  hasRuns: boolean;
};

const badgeStyle =
  "grid py-1 place-items-center whitespace-nowrap rounded-sm px-1.5 text-xs font-normal";

export function JobStatusBadge({
  enabled,
  hasIntegrationsRequiringAction,
  hasRuns,
}: JobStatusBadgeProps) {
  if (!enabled) {
    return <span className={cn(badgeStyle, "bg-slate-800 text-dimmed")}>Disabled</span>;
  }

  if (hasIntegrationsRequiringAction) {
    return <span className={cn(badgeStyle, "bg-rose-600 text-white")}>Missing Integration</span>;
  }

  if (!hasRuns) {
    return <span className={cn(badgeStyle, "bg-green-600 text-background")}>New!</span>;
  }

  return <span className={cn(badgeStyle, "bg-slate-800 text-green-500")}>Active</span>;
}
