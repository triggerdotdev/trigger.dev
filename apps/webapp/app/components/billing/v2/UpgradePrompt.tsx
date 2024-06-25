import { ExclamationCircleIcon } from "@heroicons/react/20/solid";
import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { LinkButton } from "../../primitives/Buttons";
import { Icon } from "../../primitives/Icon";
import { Paragraph } from "../../primitives/Paragraph";

type UpgradePromptProps = {
  runsEnabled: boolean;
  runCountCap: number;
  planPath: string;
};

export function UpgradePrompt({ runsEnabled, runCountCap, planPath }: UpgradePromptProps) {
  return (
    <div
      className="flex h-10 items-center justify-between border border-error bg-repeat py-0 pl-3 pr-2"
      style={{ backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }}
    >
      <div className="flex items-center gap-2">
        <Icon icon={ExclamationCircleIcon} className="h-5 w-5 text-error" />
        <Paragraph variant="small" className="text-error">
          {runsEnabled
            ? `You have exceeded the monthly ${formatNumberCompact(runCountCap)} runs
          limit`
            : `No runs are executing because you have exceeded the free limit`}
        </Paragraph>
      </div>
      <LinkButton
        variant={"primary/small"}
        LeadingIcon={ArrowUpCircleIcon}
        leadingIconClassName="px-0"
        to={planPath}
      >
        Upgrade
      </LinkButton>
    </div>
  );
}

export function useShowUpgradePrompt(organization?: MatchedOrganization) {
  const currentPlan = useCurrentPlan();
  const shouldShow =
    organization !== undefined &&
    currentPlan !== undefined &&
    currentPlan.usage.exceededRunCount &&
    currentPlan.usage.runCountCap !== undefined;

  if (!shouldShow) {
    return { shouldShow };
  }

  return {
    shouldShow,
    runCountCap: currentPlan.usage.runCountCap!,
    runsEnabled: organization.runsEnabled,
  };
}
