import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Button } from "~/components/primitives/Buttons";
import { useDashboardAgent } from "./dashboardAgentLauncher";

/**
 * Opens the agent panel with `prompt` already in play. Renders nothing when the
 * agent isn't available, so callers don't need their own gate.
 */
export function InvestigateButton({
  prompt,
  label = "Investigate",
  size = "small",
  variant = "primary",
  fullWidth,
  className,
  tooltip,
}: {
  /** What to ask. Build it with the helpers in `investigate-prompts.ts`. */
  prompt: string;
  label?: string;
  size?: "small" | "medium";
  /**
   * `primary` for the standalone accent button, `minimal` inside menus,
   * `secondary` where it sits in a row of grey buttons (the queue page).
   */
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
      LeadingIcon={MagnifyingGlassIcon}
      // A primary button is already accented; elsewhere the glyph stays quiet.
      leadingIconClassName={variant === "primary" ? undefined : "text-text-dimmed"}
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
