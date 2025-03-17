import {
  ChartBarIcon,
  Cog8ToothIcon,
  CreditCardIcon,
  UserGroupIcon,
} from "@heroicons/react/20/solid";
import { ArrowLeftIcon } from "@heroicons/react/24/solid";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import {
  organizationSettingsPath,
  organizationTeamPath,
  rootPath,
  v3BillingPath,
  v3UsagePath,
} from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";

export function OrganizationSettingsSideMenu({
  organization,
}: {
  organization: MatchedOrganization;
}) {
  const { isManagedCloud } = useFeatures();
  const currentPlan = useCurrentPlan();

  return (
    <div
      className={cn(
        "grid h-full grid-rows-[2.5rem_auto_2.5rem] overflow-hidden border-r border-grid-bright bg-background-bright transition"
      )}
    >
      <div className={cn("flex items-center justify-between p-1 transition")}>
        <LinkButton
          variant="minimal/medium"
          LeadingIcon={ArrowLeftIcon}
          to={rootPath()}
          fullWidth
          textAlignLeft
          className="text-text-bright"
        >
          Back to app
        </LinkButton>
      </div>
      <div className="mb-6 flex grow flex-col gap-1 overflow-y-auto px-1 pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <SideMenuHeader title="Organization" />
        <SideMenuItem
          name="Usage"
          icon={ChartBarIcon}
          activeIconColor="text-indigo-500"
          to={v3UsagePath(organization)}
          data-action="usage"
        />
        {isManagedCloud && (
          <SideMenuItem
            name="Billing"
            icon={CreditCardIcon}
            activeIconColor="text-emerald-500"
            to={v3BillingPath(organization)}
            data-action="billing"
            badge={
              currentPlan?.v3Subscription?.isPaying
                ? currentPlan?.v3Subscription?.plan?.title
                : undefined
            }
          />
        )}
        <SideMenuItem
          name="Team"
          icon={UserGroupIcon}
          activeIconColor="text-amber-500"
          to={organizationTeamPath(organization)}
          data-action="team"
        />
        <SideMenuItem
          name="Settings"
          icon={Cog8ToothIcon}
          activeIconColor="text-blue-500"
          to={organizationSettingsPath(organization)}
          data-action="settings"
        />
      </div>
      <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
        <HelpAndFeedback />
      </div>
    </div>
  );
}
