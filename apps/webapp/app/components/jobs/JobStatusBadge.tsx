import { ActiveBadge, MissingIntegrationBadge, NewBadge } from "../ActiveBadge";

type JobStatusBadgeProps = {
  enabled: boolean;
  hasIntegrationsRequiringAction: boolean;
  hasRuns: boolean;
  badgeSize?: "small" | "normal";
};

export function JobStatusBadge({
  enabled,
  hasIntegrationsRequiringAction,
  hasRuns,
  badgeSize = "normal",
}: JobStatusBadgeProps) {
  if (!enabled) {
    return <ActiveBadge active={false} badgeSize={badgeSize} />;
  }

  if (hasIntegrationsRequiringAction) {
    return <MissingIntegrationBadge badgeSize={badgeSize} />;
  }

  if (!hasRuns) {
    return <NewBadge badgeSize={badgeSize} />;
  }

  return <ActiveBadge active={true} badgeSize={badgeSize} />;
}
