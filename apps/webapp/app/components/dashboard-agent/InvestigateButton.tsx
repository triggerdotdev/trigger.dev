import { Button } from "~/components/primitives/Buttons";
import { AgentIcon, AGENT_ICON_ACCENT_CLASS } from "./agent-identity";
import { useDashboardAgent } from "./dashboardAgentLauncher";

/**
 * The dashboard's "Investigate" button: opens the agent panel with `prompt`
 * already in play.
 *
 * Renders nothing when the agent isn't available (no provider, or gated off) —
 * every entry point self-hides, so callers don't need their own gate.
 *
 * Icon and accent come from `agent-identity`, which the launcher and the
 * "Ask {agent}" menu item read too — so every agent surface is one recognisable
 * thing, and the character icon design is drawing lands on all of them at once.
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
  /** `primary` for the standalone accent button, `minimal` inside menus. */
  variant?: "primary" | "minimal";
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
      LeadingIcon={AgentIcon}
      // A primary button is already accented, so the icon stays on its own
      // foreground there; everywhere else it carries the agent's accent.
      leadingIconClassName={variant === "primary" ? undefined : AGENT_ICON_ACCENT_CLASS}
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
