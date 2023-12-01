import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { LinkButton } from "../primitives/Buttons";
import { Paragraph } from "../primitives/Paragraph";
import { PlansPath, organizationBillingPath } from "~/utils/pathBuilder";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";

type UpgradePromptProps = {
  organization: MatchedOrganization;
};

export function UpgradePrompt({ organization }: UpgradePromptProps) {
  const currentPlan = useCurrentPlan();

  console.log("currentPlan", currentPlan);

  if (!currentPlan || !currentPlan.usage.exceededRunCount) {
    return null;
  }

  return (
    <div className="flex h-full w-full items-center gap-4 bg-gradient-to-r from-transparent to-indigo-900/50 pr-1.5">
      <Paragraph variant="extra-small" className="text-rose-500">
        You have exceded the monthly {currentPlan.usage.runCountCap} Runs limit
      </Paragraph>
      <LinkButton
        variant={"primary/small"}
        LeadingIcon={ArrowUpCircleIcon}
        leadingIconClassName="px-0"
        to={PlansPath(organization)}
      >
        Upgrade
      </LinkButton>
    </div>
  );
}
