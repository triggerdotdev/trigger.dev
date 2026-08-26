import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { Button } from "~/components/primitives/Buttons";
import { useDashboardAgent } from "./dashboardAgentLauncher";
import { watchTooltipLabel } from "~/presenters/v3/dashboardAgent";

/** Posts nothing: opens the panel with the card pre-filled. Renders nothing without a provider. */
export function WatchButton({
  spec,
  label = "Watch…",
  size = "small",
  variant = "secondary",
  fullWidth,
  className,
  tooltip,
}: {
  spec: WatchSpec;
  label?: string;
  size?: "small" | "medium";
  variant?: "primary" | "secondary" | "minimal";
  fullWidth?: boolean;
  className?: string;
  tooltip?: string;
}) {
  const agent = useDashboardAgent();
  if (!agent) {
    return null;
  }

  return (
    <Button
      type="button"
      variant={`${variant}/${size}`}
      LeadingIcon={<AgentMonoLogo size={16} decorative />}
      fullWidth={fullWidth}
      textAlignLeft={fullWidth}
      className={className}
      tooltip={tooltip ?? watchTooltipLabel(spec)}
      onClick={() => agent.openWithWatch(spec)}
    >
      {label}
    </Button>
  );
}
