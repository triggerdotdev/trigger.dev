import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { Button } from "~/components/primitives/Buttons";
import { useDashboardAgent } from "./dashboardAgentLauncher";

// Renders nothing when the agent isn't available, so callers need no gate of their own.
export function InvestigateButton({
  prompt,
  label = "Investigate",
  size = "small",
  variant = "primary",
  fullWidth,
  className,
  tooltip,
}: {
  /** Build it with the helpers in `investigate-prompts.ts`. */
  prompt: string;
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
      tooltip={tooltip}
      onClick={() => agent.openWith(prompt)}
    >
      {label}
    </Button>
  );
}
