import {
  AcademicCapIcon,
  ArrowRightOnRectangleIcon,
  BeakerIcon,
  BellAlertIcon,
  ChartBarIcon,
  ClockIcon,
  Cog8ToothIcon,
  CreditCardIcon,
  FolderIcon,
  IdentificationIcon,
  KeyIcon,
  PlusIcon,
  RectangleStackIcon,
  ServerStackIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { UserGroupIcon, UserPlusIcon } from "@heroicons/react/24/solid";
import { useNavigation } from "@remix-run/react";
import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { type MatchedProject } from "~/hooks/useProject";
import { type User } from "~/models/user.server";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { FeedbackType } from "~/routes/resources.feedback";
import { cn } from "~/utils/cn";
import {
  accountPath,
  inviteTeamMemberPath,
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
import { LogoIcon } from "../LogoIcon";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";

type SideMenuUser = Pick<User, "email" | "admin"> & { isImpersonating: boolean };
type SideMenuProject = Pick<MatchedProject, "id" | "name" | "slug" | "version">;

type SideMenuProps = {
  user: SideMenuUser;
  project: SideMenuProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  button?: ReactNode;
  defaultValue?: FeedbackType;
};

export function SideMenu({ user, project, organization, organizations }: SideMenuProps) {
  const borderRef = useRef<HTMLDivElement>(null);
  const [showHeaderDivider, setShowHeaderDivider] = useState(false);
  const currentPlan = useCurrentPlan();
  const { isManagedCloud } = useFeatures();

  const isV3Project = project.version === "V3";
  const isFreeV3User = currentPlan?.v3Subscription?.isPaying === false;

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
          <ProjectSelector organizations={organizations} project={project} />
          <UserMenu user={user} />
        </div>
        <div
          className="h-full overflow-hidden overflow-y-auto pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          ref={borderRef}
        >
          <div className="mb-6 flex flex-col gap-1 px-1">
            <V3ProjectSideMenu organization={organization} project={project} />
          </div>
          <div className="mb-1 flex flex-col gap-1 px-1">
            <SideMenuHeader title={"Organization"}>
              <PopoverMenuItem
                to={newProjectPath(organization)}
                title="New Project"
                icon={PlusIcon}
              />
              <PopoverMenuItem
                to={inviteTeamMemberPath(organization)}
                title="Invite team member"
                icon={UserPlusIcon}
                leadingIconClassName="text-indigo-500"
              />
            </SideMenuHeader>
            <SideMenuItem
              name="Projects"
              icon={FolderIcon}
              to={organizationPath(organization)}
              data-action="projects"
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
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
          <HelpAndFeedback />
          {isFreeV3User && (
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
  organizations,
}: {
  project: SideMenuProject;
  organizations: MatchedOrganization[];
}) {
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const navigation = useNavigation();

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
        <LogoIcon className="relative -top-px mr-2 h-4 w-4 min-w-[1rem]" />
        <span className="truncate">{project.name ?? "Select a project"}</span>
      </PopoverArrowTrigger>
      <PopoverContent
        className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        {organizations.map((organization) => (
          <Fragment key={organization.id}>
            <PopoverSectionHeader title={organization.title} />
            <div className="flex flex-col gap-1 p-1">
              {organization.projects.length > 0 ? (
                organization.projects.map((p) => {
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
                      icon={FolderIcon}
                    />
                  );
                })
              ) : (
                <PopoverMenuItem
                  to={newProjectPath(organization)}
                  title="New project"
                  icon={PlusIcon}
                />
              )}
            </div>
          </Fragment>
        ))}
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem to={newOrganizationPath()} title="New Organization" icon={PlusIcon} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu({ user }: { user: SideMenuUser }) {
  const [isProfileMenuOpen, setProfileMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { v3Enabled } = useFeatures();

  useEffect(() => {
    setProfileMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setProfileMenuOpen(open)}>
      <PopoverCustomTrigger isOpen={isProfileMenuOpen} className="p-1 hover:bg-transparent">
        <UserProfilePhoto
          className={cn(
            "h-5 w-5 rounded-full border border-transparent text-charcoal-600 transition hover:border-charcoal-600",
            user.isImpersonating && "rounded-full border border-yellow-500"
          )}
        />
      </PopoverCustomTrigger>
      <PopoverContent
        className="min-w-[12rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
      >
        <Fragment>
          <PopoverSectionHeader title={user.email} variant="extra-small" />
          <div className="flex flex-col gap-1 p-1">
            {user.isImpersonating && <ImpersonationBanner />}
            {user.admin && (
              <PopoverMenuItem
                to={"/admin"}
                title="Admin"
                icon={AcademicCapIcon}
                leadingIconClassName="text-yellow-500"
              />
            )}
            <PopoverMenuItem
              to={accountPath()}
              title="View profile"
              icon={UserProfilePhoto}
              leadingIconClassName="text-indigo-500"
            />
            {v3Enabled && (
              <PopoverMenuItem
                to={personalAccessTokensPath()}
                title="Personal Access Tokens"
                icon={ShieldCheckIcon}
                leadingIconClassName="text-emerald-500"
              />
            )}
            <PopoverMenuItem
              to={logoutPath()}
              title="Log out"
              icon={ArrowRightOnRectangleIcon}
              leadingIconClassName="text-rose-500"
            />
          </div>
        </Fragment>
      </PopoverContent>
    </Popover>
  );
}

function V3ProjectSideMenu({
  project,
  organization,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
}) {
  return (
    <>
      <SideMenuHeader title={"Project"} />
      <SideMenuItem
        name="Tasks"
        icon={TaskIcon}
        activeIconColor="text-blue-500"
        to={v3ProjectPath(organization, project)}
        data-action="tasks"
      />
      <SideMenuItem
        name="Runs"
        icon={RunsIcon}
        activeIconColor="text-teal-500"
        to={v3RunsPath(organization, project)}
      />
      <SideMenuItem
        name="Batches"
        icon={Squares2X2Icon}
        activeIconColor="text-blue-500"
        to={v3BatchesPath(organization, project)}
        data-action="batches"
      />
      <SideMenuItem
        name="Test"
        icon={BeakerIcon}
        activeIconColor="text-lime-500"
        to={v3TestPath(organization, project)}
        data-action="test"
      />
      <SideMenuItem
        name="Schedules"
        icon={ClockIcon}
        activeIconColor="text-sun-500"
        to={v3SchedulesPath(organization, project)}
        data-action="schedules"
      />
      <SideMenuItem
        name="API keys"
        icon={KeyIcon}
        activeIconColor="text-amber-500"
        to={v3ApiKeysPath(organization, project)}
        data-action="api keys"
      />
      <SideMenuItem
        name="Environment variables"
        icon={IdentificationIcon}
        activeIconColor="text-pink-500"
        to={v3EnvironmentVariablesPath(organization, project)}
        data-action="environment variables"
      />

      <SideMenuItem
        name="Deployments"
        icon={ServerStackIcon}
        activeIconColor="text-blue-500"
        to={v3DeploymentsPath(organization, project)}
        data-action="deployments"
      />
      <SideMenuItem
        name="Alerts"
        icon={BellAlertIcon}
        activeIconColor="text-red-500"
        to={v3ProjectAlertsPath(organization, project)}
        data-action="alerts"
      />
      <SideMenuItem
        name="Concurrency limits"
        icon={RectangleStackIcon}
        activeIconColor="text-indigo-500"
        to={v3ConcurrencyPath(organization, project)}
        data-action="concurrency"
      />
      <SideMenuItem
        name="Project settings"
        icon={Cog8ToothIcon}
        activeIconColor="text-teal-500"
        to={v3ProjectSettingsPath(organization, project)}
        data-action="project-settings"
      />
    </>
  );
}
