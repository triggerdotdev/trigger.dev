import { cn } from "~/utils/cn";
import { ActiveBadge, MissingIntegrationBadge, NewBadge } from "../ActiveBadge";

type JobStatusBadgeProps = {
  enabled: boolean;
  hasIntegrationsRequiringAction: boolean;
  hasRuns: boolean;
};

export function JobStatusBadge({
  enabled,
  hasIntegrationsRequiringAction,
  hasRuns,
}: JobStatusBadgeProps) {
  if (!enabled) {
    return <ActiveBadge active={false} />;
  }

  if (hasIntegrationsRequiringAction) {
    return <MissingIntegrationBadge />;
  }

  if (!hasRuns) {
    return <NewBadge />;
  }

  return <ActiveBadge active={true} />;
}
