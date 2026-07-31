import { Button } from "~/components/primitives/Buttons";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { AgentIcon, AGENT_ICON_ACCENT_CLASS, ASK_AGENT_LABEL } from "./agent-identity";
import { requestDashboardAgent, useDashboardAgentAvailable } from "./dashboardAgentOpenRequest";

/**
 * "Ask {agent}" as a button, for the places that used to offer the docs chat: an
 * empty state's header row, a setup panel. Opens the agent panel, optionally with
 * a question already in play.
 *
 * Unlike `InvestigateButton` this goes through the open-request bridge rather than
 * the provider context, so it works on a page above the environment layout too.
 * It self-hides when the agent can't be opened (gated off, self-hosted without
 * it), falling back to whatever the caller passes — so a setup panel that now
 * offers the agent instead of a row of docs links still offers the docs links to
 * someone who has no agent.
 */
export function AskAgentButton({
  prompt,
  label = ASK_AGENT_LABEL,
  /** Icon only, with the label as a tooltip — the empty-state header row idiom. */
  iconOnly = false,
  variant = "small-menu-item",
  className,
  /** What to show instead when the agent can't be opened (a docs link, usually). */
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
  if (!available) return <>{fallback}</>;

  const button = (
    <Button
      type="button"
      variant={variant}
      data-action="ask-agent"
      LeadingIcon={AgentIcon}
      leadingIconClassName={AGENT_ICON_ACCENT_CLASS}
      className={className}
      onClick={() => requestDashboardAgent(prompt)}
    >
      {iconOnly ? undefined : label}
    </Button>
  );

  return iconOnly ? <SimpleTooltip button={button} content={label} /> : button;
}
