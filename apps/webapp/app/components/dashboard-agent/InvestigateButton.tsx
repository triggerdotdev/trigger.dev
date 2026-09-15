import { Button } from "~/components/primitives/Buttons";
import { useDashboardAgent } from "./dashboardAgentLauncher";

// Renders nothing when the agent isn't available, so callers need no gate of their own.
export function InvestigateButton({
  prompt,
  label = "Investigate",
  size = "small",
  fullWidth,
  className,
  tooltip,
}: {
  /** Build it with the helpers in `investigate-prompts.ts`. */
  prompt: string;
  label?: string;
  size?: "small" | "medium";
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
      variant={`ask-trigger/${size}`}
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
