import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { plansPath } from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { Paragraph } from "../primitives/Paragraph";
import { Callout } from "../primitives/Callout";

type UpgradePromptProps = {
  organization: MatchedOrganization;
};

export function UpgradePrompt({ organization }: UpgradePromptProps) {
  const currentPlan = useCurrentPlan();

  if (!currentPlan || !currentPlan.usage.exceededRunCount || !currentPlan.usage.runCountCap) {
    return null;
  }

  return (
    <Callout variant="error" className="flex h-full items-center rounded-none px-1 py-0">
      <div className="flex items-center justify-between gap-3">
        <Paragraph variant="extra-small" className="text-white">
          {organization.runsEnabled
            ? `You have exceeded the monthly ${formatNumberCompact(
                currentPlan.usage.runCountCap
              )} runs
          limit`
            : `No runs are executing because you have exceeded the free limit`}
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
    </Callout>
  );
}
