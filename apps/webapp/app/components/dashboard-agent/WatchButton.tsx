import { EyeIcon } from "@heroicons/react/20/solid";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { Button } from "~/components/primitives/Buttons";
import { useDashboardAgent } from "./dashboardAgentLauncher";
import { watchTooltipLabel } from "~/presenters/v3/dashboardAgent";

/**
 * The universal Watch action, used by runs, queues, errors and health.
 *
 * The entry is universal and the recommendation is contextual: the caller passes the
 * spec its object recommends, and every other variant lives one tap deeper under
 * Customize. Unlike `InvestigateButton` this posts nothing, it opens the panel with
 * the card pre-filled, so an abandoned card leaves no trace in the transcript.
 *
 * Self-hiding like every agent entry point: with no provider it renders nothing, so
 * callers need no gate of their own.
 */
export function WatchButton({
  spec,
  label = "Watch…",
  size = "small",
  variant = "secondary",
  fullWidth,
  className,
  tooltip,
}: {
  /** The recommended condition for this object, already filled in. */
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
      // The same eye the chat's Watch block wears: the watch is about the object,
      // not the agent, so the button doesn't carry the agent's glyph.
      LeadingIcon={EyeIcon}
      leadingIconClassName={variant === "primary" ? undefined : "text-text-dimmed"}
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
