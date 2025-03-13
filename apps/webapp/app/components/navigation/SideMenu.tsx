import {
  AcademicCapIcon,
  ArrowPathRoundedSquareIcon,
  ArrowRightOnRectangleIcon,
  BeakerIcon,
  BellAlertIcon,
  ChartBarIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog8ToothIcon,
  CogIcon,
  CreditCardIcon,
  FolderIcon,
  FolderOpenIcon,
  IdentificationIcon,
  KeyIcon,
  PlusIcon,
  RectangleStackIcon,
  ServerStackIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { UserGroupIcon } from "@heroicons/react/24/solid";
import { useNavigation } from "@remix-run/react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import simplur from "simplur";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { Avatar } from "~/components/primitives/Avatar";
import { type MatchedEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { type MatchedProject } from "~/hooks/useProject";
import { type User } from "~/models/user.server";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { type FeedbackType } from "~/routes/resources.feedback";
import { cn } from "~/utils/cn";
import {
  accountPath,
  logoutPath,
  newOrganizationPath,
  newProjectPath,
  organizationPath,
  organizationSettingsPath,
  organizationTeamPath,
  personalAccessTokensPath,
  v3ApiKeysPath,
  v3BatchesPath,
  v3BillingPath,
  v3ConcurrencyPath,
  v3DeploymentsPath,
  v3EnvironmentPath,
  v3EnvironmentVariablesPath,
  v3ProjectAlertsPath,
  v3ProjectPath,
  v3ProjectSettingsPath,
  v3RunsPath,
  v3SchedulesPath,
  v3TestPath,
  v3UsagePath,
} from "~/utils/pathBuilder";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { Paragraph } from "../primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverTrigger,
} from "../primitives/Popover";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";
import { ButtonContent, LinkButton } from "../primitives/Buttons";
import { useUser } from "~/hooks/useUser";

type SideMenuUser = Pick<User, "email" | "admin"> & { isImpersonating: boolean };
export type SideMenuProject = Pick<
  MatchedProject,
  "id" | "name" | "slug" | "version" | "environments"
>;
export type SideMenuEnvironment = MatchedEnvironment;

type SideMenuProps = {
  user: SideMenuUser;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  button?: ReactNode;
  defaultValue?: FeedbackType;
};

export function SideMenu({
  user,
  project,
  environment,
  organization,
  organizations,
}: SideMenuProps) {
  const borderRef = useRef<HTMLDivElement>(null);
  const [showHeaderDivider, setShowHeaderDivider] = useState(false);
  const currentPlan = useCurrentPlan();
  const isFreeUser = currentPlan?.v3Subscription?.isPaying === false;

  useEffect(() => {
    const handleScroll = () => {
      if (borderRef.current) {
        const shouldShowHeaderDivider = borderRef.current.scrollTop > 1;
        if (showHeaderDivider !== shouldShowHeaderDivider) {
          setShowHeaderDivider(shouldShowHeaderDivider);
        }
      }
    };

    borderRef.current?.addEventListener("scroll", handleScroll);
    return () => borderRef.current?.removeEventListener("scroll", handleScroll);
  }, [showHeaderDivider]);

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-grid-bright bg-background-bright transition"
      )}
    >
      <div className="flex h-full flex-col">
        <div
          className={cn(
            "flex items-center justify-between px-1 py-1 transition",
            showHeaderDivider ? " border-grid-bright" : "border-transparent"
          )}
        >
          <ProjectSelector
            organizations={organizations}
            organization={organization}
            project={project}
            user={user}
          />
        </div>
        <div
          className="h-full overflow-hidden overflow-y-auto pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          ref={borderRef}
        >
          <div className="mb-6 flex flex-col gap-4 px-1">
            <div className="space-y-1">
              <SideMenuHeader title={"Environment"} />
              <div className="flex items-center gap-2">
                <EnvironmentSelector project={project} environment={environment} />
              </div>
            </div>

            <div>
              <SideMenuItem
                name="Tasks"
                icon={TaskIcon}
                activeIconColor="text-blue-500"
                to={v3EnvironmentPath(organization, project, environment)}
                data-action="tasks"
              />
              <SideMenuItem
                name="Batches"
                icon={Squares2X2Icon}
                activeIconColor="text-blue-500"
                to={v3BatchesPath(organization, project, environment)}
                data-action="batches"
              />
              <SideMenuItem
                name="Schedules"
                icon={ClockIcon}
                activeIconColor="text-sun-500"
                to={v3SchedulesPath(organization, project, environment)}
                data-action="schedules"
              />
              <SideMenuItem
                name="Deployments"
                icon={ServerStackIcon}
                activeIconColor="text-blue-500"
                to={v3DeploymentsPath(organization, project, environment)}
                data-action="deployments"
              />
              <SideMenuItem
                name="Test"
                icon={BeakerIcon}
                activeIconColor="text-lime-500"
                to={v3TestPath(organization, project, environment)}
                data-action="test"
              />
            </div>

            <SideMenuSection title="Observability">
              <SideMenuItem
                name="Runs"
                icon={RunsIcon}
                activeIconColor="text-teal-500"
                to={v3RunsPath(organization, project, environment)}
              />
              <SideMenuItem
                name="Alerts"
                icon={BellAlertIcon}
                activeIconColor="text-red-500"
                to={v3ProjectAlertsPath(organization, project, environment)}
                data-action="alerts"
              />
            </SideMenuSection>

            <SideMenuSection title="Manage">
              <SideMenuItem
                name="API keys"
                icon={KeyIcon}
                activeIconColor="text-amber-500"
                to={v3ApiKeysPath(organization, project, environment)}
                data-action="api keys"
              />
              <SideMenuItem
                name="Environment variables"
                icon={IdentificationIcon}
                activeIconColor="text-pink-500"
                to={v3EnvironmentVariablesPath(organization, project, environment)}
                data-action="environment variables"
              />

              <SideMenuItem
                name="Concurrency limits"
                icon={RectangleStackIcon}
                activeIconColor="text-indigo-500"
                to={v3ConcurrencyPath(organization, project, environment)}
                data-action="concurrency"
              />
              <SideMenuItem
                name="Project settings"
                icon={Cog8ToothIcon}
                activeIconColor="text-teal-500"
                to={v3ProjectSettingsPath(organization, project, environment)}
                data-action="project-settings"
              />
              <SideMenuItem
                name="Team"
                icon={UserGroupIcon}
                to={organizationTeamPath(organization)}
                activeIconColor="text-amber-500"
                data-action="team"
              />
              <SideMenuItem
                name="Usage"
                icon={ChartBarIcon}
                to={v3UsagePath(organization)}
                activeIconColor="text-green-600"
                data-action="usage"
              />
              <SideMenuItem
                name="Billing"
                icon={CreditCardIcon}
                to={v3BillingPath(organization)}
                activeIconColor="text-blue-600"
                data-action="billing"
                badge={
                  currentPlan?.v3Subscription?.isPaying
                    ? currentPlan?.v3Subscription?.plan?.title
                    : undefined
                }
              />
              <SideMenuItem
                name="Organization settings"
                icon={Cog8ToothIcon}
                activeIconColor="text-teal-500"
                to={organizationSettingsPath(organization)}
                data-action="organization-settings"
              />
            </SideMenuSection>
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
          <HelpAndFeedback />
          {isFreeUser && (
            <FreePlanUsage
              to={v3BillingPath(organization)}
              percentage={currentPlan.v3Usage.usagePercentage}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectSelector({
  project,
  organization,
  organizations,
  user,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  user: SideMenuUser;
}) {
  const currentPlan = useCurrentPlan();
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const navigation = useNavigation();

  let plan: string | undefined = undefined;
  if (currentPlan?.v3Subscription?.isPaying === false) {
    plan = "Free plan";
  } else if (currentPlan?.v3Subscription?.isPaying === true) {
    plan = currentPlan.v3Subscription.plan?.title;
  }

  useEffect(() => {
    setOrgMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setOrgMenuOpen(open)} open={isOrgMenuOpen}>
      <PopoverArrowTrigger
        isOpen={isOrgMenuOpen}
        overflowHidden
        className="h-7 w-full justify-between overflow-hidden py-1 pl-2"
      >
        <div className="flex items-center gap-1.5">
          <Avatar avatar={organization.avatar} className="size-5" />
          <SelectorDivider />
          <span className="truncate text-2sm font-normal text-text-bright">
            {project.name ?? "Select a project"}
          </span>
        </div>
      </PopoverArrowTrigger>
      <PopoverContent
        className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <div className="flex flex-col gap-2 bg-charcoal-750 p-2">
          <div className="flex items-center gap-2.5">
            <div className="size-10 overflow-clip rounded-sm border border-charcoal-700 bg-charcoal-850">
              <Avatar avatar={organization.avatar} className="size-10" includePadding />
            </div>
            <div className="space-y-0.5">
              <Paragraph variant="extra-small/bright">{organization.title}</Paragraph>
              <div className="flex items-baseline">
                {plan && <Paragraph variant="extra-small">{plan}</Paragraph>}
                <Paragraph variant="extra-small">{simplur`${organization.membersCount} member[|s]`}</Paragraph>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LinkButton
              variant="secondary/small"
              to={organizationSettingsPath(organization)}
              fullWidth
              iconSpacing="gap-1.5"
            >
              <CogIcon className="size-4 text-text-dimmed" />
              <span className="text-text-bright">Settings</span>
            </LinkButton>
            <LinkButton
              variant="secondary/small"
              to={v3UsagePath(organization)}
              fullWidth
              iconSpacing="gap-1.5"
            >
              <ChartBarIcon className="size-4 text-text-dimmed" />
              <span className="text-text-bright">Usage</span>
            </LinkButton>
          </div>
        </div>
        <div className="flex flex-col gap-1 p-1">
          {organization.projects.map((p) => {
            const isSelected = p.id === project.id;
            return (
              <PopoverMenuItem
                key={p.id}
                to={v3ProjectPath(organization, p)}
                title={
                  <div className="flex w-full items-center justify-between text-text-bright">
                    <span className="grow truncate text-left">{p.name}</span>
                  </div>
                }
                isSelected={isSelected}
                icon={isSelected ? FolderOpenIcon : FolderIcon}
                leadingIconClassName="text-indigo-500"
              />
            );
          })}
          <PopoverMenuItem to={newProjectPath(organization)} title="New project" icon={PlusIcon} />
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <SwitchOrganizations organizations={organizations} organization={organization} />
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem
            to={accountPath()}
            title="Account"
            icon={UserProfilePhoto}
            leadingIconClassName={cn(
              "text-text-dimmed rounded-full border border-transparent",
              user.isImpersonating && "rounded-full border-yellow-500"
            )}
          />
          {user.isImpersonating && <ImpersonationBanner />}
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem
            to={logoutPath()}
            title="Logout"
            icon={ArrowRightOnRectangleIcon}
            leadingIconClassName="text-text-dimmed"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SwitchOrganizations({
  organizations,
  organization,
}: {
  organizations: MatchedOrganization[];
  organization: MatchedOrganization;
}) {
  const navigation = useNavigation();
  const [isMenuOpen, setMenuOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [navigation.location?.pathname]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setMenuOpen(true);
  };

  const handleMouseLeave = () => {
    // Small delay before closing to allow moving to the content
    timeoutRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, 150);
  };

  return (
    <Popover onOpenChange={(open) => setMenuOpen(open)} open={isMenuOpen}>
      <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        <PopoverTrigger className="h-7 w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            LeadingIcon={ArrowPathRoundedSquareIcon}
            leadingIconClassName="text-text-dimmed"
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            Switch organization
          </ButtonContent>
        </PopoverTrigger>
        <PopoverContent
          className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
          side="right"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="p-1">
            {organizations.map((org) => (
              <PopoverMenuItem
                key={org.id}
                to={organizationPath(org)}
                title={org.title}
                leadingIconClassName="text-text-dimmed"
              />
            ))}
          </div>
          <div className="border-t border-charcoal-700 p-1">
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New Organization"
              icon={PlusIcon}
              leadingIconClassName="text-text-dimmed"
            />
          </div>
        </PopoverContent>
      </div>
    </Popover>
  );
}

function SelectorDivider() {
  return (
    <svg width="6" height="21" viewBox="0 0 6 21" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line
        x1="5.3638"
        y1="0.606339"
        x2="0.606339"
        y2="19.6362"
        stroke="#3B3E45"
        strokeLinecap="round"
      />
    </svg>
  );
}
