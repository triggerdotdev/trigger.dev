import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { plansPath } from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { Paragraph } from "../primitives/Paragraph";

type UpgradePromptProps = {
  organization: MatchedOrganization;
};

export function UpgradePrompt({ organization }: UpgradePromptProps) {
  const currentPlan = useCurrentPlan();

  if (!currentPlan || !currentPlan.usage.exceededRunCount || !currentPlan.usage.runCountCap) {
    return null;
  }

  return (
    <div className="flex h-full w-full items-center gap-4 bg-gradient-to-r from-transparent to-indigo-900/50 pr-1.5">
      <Paragraph variant="extra-small" className="text-rose-500">
        You have exceeded the monthly {formatNumberCompact(currentPlan.usage.runCountCap)} Runs
        limit
      </Paragraph>
      <LinkButton
        variant={"primary/small"}
        LeadingIcon={ArrowUpCircleIcon}
        leadingIconClassName="px-0"
        to={plansPath(organization)}
      >
        Upgrade
      </LinkButton>
    </div>
  );
}
