import {
  BellAlertIcon,
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
  v3BillingAlertsPath,
  v3BillingPath,
  v3UsagePath,
} from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { Paragraph } from "../primitives/Paragraph";
import { Badge } from "../primitives/Badge";
import { useHasAdminAccess } from "~/hooks/useUser";

export type BuildInfo = {
  appVersion: string | undefined;
  packageVersion: string;
  buildTimestampSeconds: string | undefined;
  gitSha: string | undefined;
  gitRefName: string | undefined;
};

export function OrganizationSettingsSideMenu({
  organization,
  buildInfo,
}: {
  organization: MatchedOrganization;
  buildInfo: BuildInfo;
}) {
  const { isManagedCloud } = useFeatures();
  const currentPlan = useCurrentPlan();
  const isAdmin = useHasAdminAccess();
  const showBuildInfo = isAdmin || !isManagedCloud;

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
        >
          <span className="text-text-bright">Back to app</span>
        </LinkButton>
      </div>
      <div className="mb-6 flex grow flex-col gap-4 overflow-y-auto px-1 pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col">
          <div className="mb-1">
            <SideMenuHeader title="Organization" />
          </div>
          {isManagedCloud && (
            <>
              <SideMenuItem
                name="Usage"
                icon={ChartBarIcon}
                activeIconColor="text-indigo-500"
                to={v3UsagePath(organization)}
                data-action="usage"
              />
              <SideMenuItem
                name="Billing"
                icon={CreditCardIcon}
                activeIconColor="text-emerald-500"
                to={v3BillingPath(organization)}
                data-action="billing"
                badge={
                  currentPlan?.v3Subscription?.isPaying ? (
                    <Badge variant="extra-small">{currentPlan?.v3Subscription?.plan?.title}</Badge>
                  ) : undefined
                }
              />
              <SideMenuItem
                name="Billing alerts"
                icon={BellAlertIcon}
                activeIconColor="text-rose-500"
                to={v3BillingAlertsPath(organization)}
                data-action="billing-alerts"
              />
            </>
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
            activeIconColor="text-orgSettings"
            to={organizationSettingsPath(organization)}
            data-action="settings"
          />
        </div>
        <div className="flex flex-col gap-1">
          <SideMenuHeader title="App version" />
          <Paragraph variant="extra-small" className="px-2 text-text-dimmed">
            {buildInfo.appVersion || `v${buildInfo.packageVersion}`}
          </Paragraph>
        </div>
        {showBuildInfo && buildInfo.buildTimestampSeconds && (
          <div className="flex flex-col gap-1">
            <SideMenuHeader title="Build timestamp" />
            <Paragraph variant="extra-small" className="px-2 text-text-dimmed">
              {new Date(Number(buildInfo.buildTimestampSeconds) * 1000).toISOString()}
            </Paragraph>
          </div>
        )}
        {showBuildInfo && buildInfo.gitRefName && (
          <div className="flex flex-col gap-1">
            <SideMenuHeader title="Git ref" />
            <Paragraph variant="extra-small" className="px-2 text-text-dimmed">
              {buildInfo.gitRefName}
            </Paragraph>
          </div>
        )}
        {showBuildInfo && buildInfo.gitSha && (
          <div className="flex flex-col gap-1">
            <SideMenuHeader title="Git sha" />
            <Paragraph variant="extra-small" className="px-2 text-text-dimmed">
              {buildInfo.gitSha.slice(0, 9)}
            </Paragraph>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
        <HelpAndFeedback />
      </div>
    </div>
  );
}
