import { EyeIcon } from "@heroicons/react/20/solid";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { Button } from "~/components/primitives/Buttons";
import { useDashboardAgent } from "./dashboardAgentLauncher";

/**
 * The universal **Watch…** action (§2.1).
 *
 * One entry, four objects — run, queue, error, health. The ENTRY is universal and
 * the RECOMMENDATION is contextual: the caller passes the spec its object
 * recommends (a run → when it finishes, a queue → when it drains, an error → if
 * it happens again, a degraded health report → when it recovers), and every other
 * variant lives one tap deeper under **Customize**. That is why there is no
 * per-object label prop worth setting and no secondary "other options" entry.
 *
 * Unlike `InvestigateButton` this posts NOTHING: it opens the panel with the card
 * pre-filled, and an abandoned card leaves no trace in the transcript.
 *
 * Self-hiding, like every agent entry point: no provider (or the agent gated off)
 * renders nothing, so callers need no gate of their own. The eye glyph matches
 * the chat's Watch block — the watch is the object, not the agent.
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
      // The same eye the chat's Watch block wears — a watch is the object here,
      // not the agent, so the button doesn't carry the agent's glyph.
      LeadingIcon={EyeIcon}
      leadingIconClassName={variant === "primary" ? undefined : "text-text-dimmed"}
      fullWidth={fullWidth}
      textAlignLeft={fullWidth}
      className={className}
      tooltip={tooltip}
      onClick={() => agent.openWithWatch(spec)}
    >
      {label}
    </Button>
  );
}
