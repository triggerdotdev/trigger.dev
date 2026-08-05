import { Link } from "@remix-run/react";
import { LinkButton } from "~/components/primitives/Buttons";
import { useOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { v3BillingPath } from "~/utils/pathBuilder";
import { AgentIcon, AGENT_ICON_ACCENT_CLASS, ASK_AGENT_LABEL } from "./agent-identity";

/**
 * The Free plan's message cap, at the bottom of the panel.
 * {@link AgentQuotaNotice} sits under the composer while messages are left;
 * {@link AgentUpgradeBlock} replaces the composer once the cap is reached.
 * Both stay in the composer's slot so the transcript above is untouched.
 */

/** The composer's own outer geometry, so the replacement lands in the same place. */
const SLOT = "flex shrink-0 flex-col bg-background-bright px-3 pb-3 pt-1";

export function AgentUpgradeBlock({
  limit,
  /** The composer's context banner, so replacing the composer doesn't lose it. */
  context,
}: {
  limit: number;
  context?: React.ReactNode;
}) {
  const organization = useOrganization();

  return (
    <div className={SLOT}>
      {context}
      <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-border-bright bg-background-dimmed p-3">
        <div className="flex items-center gap-1.5">
          <AgentIcon className={cn("size-4 shrink-0", AGENT_ICON_ACCENT_CLASS)} />
          <span className="text-sm font-medium text-text-bright">
            Upgrade to unlock {ASK_AGENT_LABEL}
          </span>
        </div>
        <p className="text-xs text-text-dimmed">
          You've used all {limit} messages included on the Free plan. Your chats stay here to read.
        </p>
        <LinkButton variant="primary/small" to={v3BillingPath(organization)} fullWidth>
          Upgrade
        </LinkButton>
      </div>
    </div>
  );
}

export function AgentQuotaNotice({ remaining, limit }: { remaining: number; limit: number }) {
  const organization = useOrganization();

  return (
    <div className="flex shrink-0 items-center gap-1 bg-background-bright px-3 pb-2 text-xs text-text-dimmed">
      <span>
        {remaining} of {limit} free messages left
      </span>
      <span aria-hidden>·</span>
      <Link
        to={v3BillingPath(organization)}
        className="text-text-link underline-offset-2 hover:underline"
      >
        Upgrade
      </Link>
    </div>
  );
}
