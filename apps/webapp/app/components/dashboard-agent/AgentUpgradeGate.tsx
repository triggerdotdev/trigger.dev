import { Link } from "@remix-run/react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { LinkButton } from "~/components/primitives/Buttons";
import { textLinkClassName } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { v3BillingPath } from "~/utils/pathBuilder";
import { ASK_AGENT_LABEL } from "./agent-identity";
import { messageQuotaReachedCopy } from "./message-quota";

// Matches the composer's outer geometry so the replacement lands in the same place.
const SLOT = "flex shrink-0 flex-col bg-background-bright px-3 pt-1";

type AgentUpgradeBlockProps = {
  limit: number;
  planResolved: boolean;
  context?: React.ReactNode;
};

export function AgentUpgradeBlock(props: AgentUpgradeBlockProps) {
  const organization = useOrganization();
  return <AgentUpgradeBlockView {...props} upgradePath={v3BillingPath(organization)} />;
}

/** The block without the organization lookup, so it renders outside an org route. */
export function AgentUpgradeBlockView({
  limit,
  planResolved,
  context,
  upgradePath,
}: AgentUpgradeBlockProps & { upgradePath: string }) {
  return (
    <div className={SLOT}>
      {context}
      <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-border-bright bg-background-dimmed p-3">
        <div className="flex items-center gap-1.5">
          <AISparkleIcon className="size-4 shrink-0" />
          <span className="text-sm font-medium text-text-bright">
            Upgrade to unlock {ASK_AGENT_LABEL}
          </span>
        </div>
        <p className="text-xs text-text-dimmed">{messageQuotaReachedCopy(limit, planResolved)}</p>
        <LinkButton variant="primary/small" to={upgradePath} fullWidth>
          Upgrade
        </LinkButton>
      </div>
    </div>
  );
}

type AgentQuotaNoticeProps = { remaining: number; limit: number };

export function AgentQuotaNotice(props: AgentQuotaNoticeProps) {
  const organization = useOrganization();
  return <AgentQuotaNoticeView {...props} upgradePath={v3BillingPath(organization)} />;
}

/** The notice without the organization lookup, so it renders outside an org route. */
export function AgentQuotaNoticeView({
  remaining,
  limit,
  upgradePath,
}: AgentQuotaNoticeProps & { upgradePath: string }) {
  return (
    <div className="flex items-center gap-1 text-xs text-text-dimmed">
      <span>
        {remaining} of {limit} free messages left
      </span>
      <span aria-hidden>·</span>
      <Link to={upgradePath} className={textLinkClassName()}>
        Upgrade
      </Link>
    </div>
  );
}
