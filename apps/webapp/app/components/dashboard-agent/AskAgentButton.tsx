import { Button } from "~/components/primitives/Buttons";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { AgentIcon, AGENT_ICON_ACCENT_CLASS, ASK_AGENT_LABEL } from "./agent-identity";
import { requestDashboardAgent, useDashboardAgentAvailable } from "./dashboardAgentOpenRequest";

// Goes through the open-request bridge rather than the provider context, so it works
// on pages above the environment layout.
export function AskAgentButton({
  prompt,
  label = ASK_AGENT_LABEL,
  iconOnly = false,
  variant = "small-menu-item",
  className,
  fallback = null,
}: {
  prompt?: string;
  label?: string;
  iconOnly?: boolean;
  variant?: "small-menu-item" | "secondary/small" | "primary/small";
  className?: string;
  fallback?: React.ReactNode;
}) {
  const available = useDashboardAgentAvailable();
  if (!available) return fallback;

  const button = (
    <Button
      type="button"
      variant={variant}
      data-action="ask-agent"
      LeadingIcon={AgentIcon}
      leadingIconClassName={AGENT_ICON_ACCENT_CLASS}
      className={className}
      aria-label={iconOnly ? label : undefined}
      onClick={() => requestDashboardAgent(prompt)}
    >
      {iconOnly ? undefined : label}
    </Button>
  );

  return iconOnly ? (
    <SimpleTooltip
      asChild
      tabbable
      // Span wrapper: Button drops the pointer-event props Radix injects via asChild, so the
      // tooltip trigger has to be a plain element (same pattern as dashboardAgentLauncher).
      button={<span className="flex">{button}</span>}
      content={label}
    />
  ) : (
    button
  );
}
