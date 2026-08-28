import { Link } from "@remix-run/react";
import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { LinkButton } from "~/components/primitives/Buttons";
import { textLinkClassName } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { v3BillingPath } from "~/utils/pathBuilder";
import { ASK_AGENT_LABEL } from "./agent-identity";
import { messageQuotaReachedCopy } from "./message-quota";

// Matches the composer's outer geometry so the replacement lands in the same place.
const SLOT = "flex shrink-0 flex-col bg-background-bright px-3 pb-3 pt-1";

export function AgentUpgradeBlock({
  limit,
  planResolved,
  context,
}: {
  limit: number;
  planResolved: boolean;
  context?: React.ReactNode;
}) {
  const organization = useOrganization();

  return (
    <div className={SLOT}>
      {context}
      <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-border-bright bg-background-dimmed p-3">
        <div className="flex items-center gap-1.5">
          <AgentMonoLogo size={16} decorative className="shrink-0" />
          <span className="text-sm font-medium text-text-bright">
            Upgrade to unlock {ASK_AGENT_LABEL}
          </span>
        </div>
        <p className="text-xs text-text-dimmed">{messageQuotaReachedCopy(limit, planResolved)}</p>
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
      <Link to={v3BillingPath(organization)} className={textLinkClassName()}>
        Upgrade
      </Link>
    </div>
  );
}
