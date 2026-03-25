import { ExclamationCircleIcon } from "@heroicons/react/20/solid";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { MatchedOrganization, useOrganization } from "~/hooks/useOrganizations";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { v3BillingPath } from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { Icon } from "../primitives/Icon";
import { Paragraph } from "../primitives/Paragraph";
import { DateTime } from "~/components/primitives/DateTime";

export function UpgradePrompt() {
  const organization = useOrganization();
  const plan = useCurrentPlan();

  if (!plan || !plan.v3Usage.hasExceededFreeTier) {
    return null;
  }

  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getMonth() + 1);
  nextMonth.setUTCDate(1);
  nextMonth.setUTCHours(0, 0, 0, 0);

  return (
    <div
      className="flex h-10 items-center justify-between border border-error bg-repeat py-0 pl-3 pr-2"
      style={{ backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }}
    >
      <div className="flex items-center gap-2">
        <Icon icon={ExclamationCircleIcon} className="h-5 w-5 text-error" />
        <Paragraph variant="small" className="text-error">
          You have exceeded the monthly $
          {(plan.v3Subscription?.plan?.limits.includedUsage ?? 500) / 100} free credits. Existing
          runs will be queued and new runs won't be created until{" "}
          <DateTime date={nextMonth} includeTime={false} timeZone="utc" />, or you upgrade.
        </Paragraph>
      </div>
      <LinkButton
        variant={"primary/small"}
        leadingIconClassName="px-0"
        to={v3BillingPath(organization)}
      >
        Upgrade
      </LinkButton>
    </div>
  );
}

export function useShowUpgradePrompt(organization?: MatchedOrganization) {
  const currentPlan = useCurrentPlan();
  const shouldShow = currentPlan?.v3Usage.hasExceededFreeTier === true;
  return { shouldShow };
}
