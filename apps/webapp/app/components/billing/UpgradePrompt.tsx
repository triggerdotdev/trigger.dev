import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { LinkButton } from "../primitives/Buttons";
import { Paragraph } from "../primitives/Paragraph";
import { organizationBillingPath } from "~/utils/pathBuilder";
import { MatchedOrganization } from "~/hooks/useOrganizations";

type UpgradePromptProps = {
  organization: MatchedOrganization;
};

export function UpgradePrompt({ organization }: UpgradePromptProps) {
  return (
    <div className="flex h-full w-full items-center gap-4 bg-gradient-to-r from-transparent to-indigo-900/50 pr-1.5">
      <Paragraph variant="extra-small" className="text-rose-500">
        You have exceded the monthly 10,000 Runs limit
      </Paragraph>
      <LinkButton
        variant={"primary/small"}
        LeadingIcon={ArrowUpCircleIcon}
        leadingIconClassName="px-0"
        to={organizationBillingPath(organization)}
      >
        Upgrade
      </LinkButton>
    </div>
  );
}
