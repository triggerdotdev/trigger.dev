import {
  AcademicCapIcon,
  ArrowRightIcon,
  ArrowRightOnRectangleIcon,
  BeakerIcon,
  BellAlertIcon,
  ChartBarIcon,
  ClockIcon,
  CurrencyDollarIcon,
  CursorArrowRaysIcon,
  IdentificationIcon,
  KeyIcon,
  ServerStackIcon,
  ShieldCheckIcon,
} from "@heroicons/react/20/solid";
import { UserGroupIcon, UserPlusIcon } from "@heroicons/react/24/solid";
import { useNavigation } from "@remix-run/react";
import { DiscordIcon, SlackIcon } from "@trigger.dev/companyicons";
import { Fragment, useEffect, useRef, useState } from "react";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { useFeatures } from "~/hooks/useFeatures";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { MatchedProject } from "~/hooks/useProject";
import { User } from "~/models/user.server";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { cn } from "~/utils/cn";
import {
  accountPath,
  inviteTeamMemberPath,
  logoutPath,
  newOrganizationPath,
  newProjectPath,
  organizationBillingPath,
  organizationIntegrationsPath,
  organizationPath,
  organizationSettingsPath,
  organizationTeamPath,
  personalAccessTokensPath,
  projectEnvironmentsPath,
  projectEventsPath,
  projectHttpEndpointsPath,
  projectPath,
  projectRunsPath,
  projectSettingsPath,
  projectSetupPath,
  projectTriggersPath,
  v3ApiKeysPath,
  v3DeploymentsPath,
  v3EnvironmentVariablesPath,
  v3ProjectAlertsPath,
  v3ProjectPath,
  v3ProjectSettingsPath,
  v3RunsPath,
  v3SchedulesPath,
  v3TestPath,
  v3BillingPath,
  v3UsagePath,
} from "~/utils/pathBuilder";
import { Feedback } from "../Feedback";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { LogoIcon } from "../LogoIcon";
import { StepContentContainer } from "../StepContentContainer";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { FreePlanUsage } from "../billing/v2/FreePlanUsage";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import { ClipboardField } from "../primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { Icon } from "../primitives/Icon";
import { Paragraph } from "../primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";
import { StepNumber } from "../primitives/StepNumber";
import { SideMenuHeader } from "./SideMenuHeader";
import { MenuCount, SideMenuItem } from "./SideMenuItem";

type SideMenuUser = Pick<User, "email" | "admin"> & { isImpersonating: boolean };
type SideMenuProject = Pick<
  MatchedProject,
  | "id"
  | "name"
  | "slug"
  | "hasInactiveExternalTriggers"
  | "jobCount"
  | "httpEndpointCount"
  | "version"
>;

type SideMenuProps = {
  user: SideMenuUser;
  project: SideMenuProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
};

export function SideMenu({ user, project, organization, organizations }: SideMenuProps) {
  const borderRef = useRef<HTMLDivElement>(null);
  const [showHeaderDivider, setShowHeaderDivider] = useState(false);
  const { isManagedCloud } = useFeatures();
  const currentPlan = useCurrentPlan();

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
            {project.version === "V2" ? (
              <V2ProjectSideMenu organization={organization} project={project} />
            ) : (
              <V3ProjectSideMenu organization={organization} project={project} />
            )}
          </div>
          <div className="mb-1 flex flex-col gap-1 px-1">
            <SideMenuHeader title={"Organization"}>
              <PopoverMenuItem to={newProjectPath(organization)} title="New Project" icon="plus" />
              <PopoverMenuItem
                to={inviteTeamMemberPath(organization)}
                title="Invite team member"
                icon={UserPlusIcon}
                leadingIconClassName="text-indigo-500"
              />
            </SideMenuHeader>
            {project.version === "V2" && (
              <SideMenuItem
                name="Integrations"
                icon="integration"
                to={organizationIntegrationsPath(organization)}
                data-action="integrations"
                hasWarning={organization.hasUnconfiguredIntegrations}
              />
            )}
            <SideMenuItem
              name="Projects"
              icon="folder"
              to={organizationPath(organization)}
              data-action="projects"
            />
            <SideMenuItem
              name="Team"
              icon={UserGroupIcon}
              to={organizationTeamPath(organization)}
              iconColor="text-sky-500"
              data-action="team"
            />
            <SideMenuItem
              name="Usage"
              icon={ChartBarIcon}
              to={v3UsagePath(organization)}
              iconColor="text-green-600"
              data-action="usage"
            />
            <SideMenuItem
              name="Billing"
              icon={CurrencyDollarIcon}
              to={v3BillingPath(organization)}
              iconColor="text-sun-600"
              data-action="billing"
            />
            {organization.projects.some((proj) => proj.version === "V2") && (
              <SideMenuItem
                name="Usage (v2)"
                icon={ChartBarIcon}
                to={organizationBillingPath(organization)}
                iconColor="text-green-600"
                data-action="usage & billing"
              />
            )}
            <SideMenuItem
              name="Organization settings"
              icon="settings"
              iconColor="text-teal-500"
              to={organizationSettingsPath(organization)}
              data-action="organization-settings"
            />
          </div>
        </div>
        <div className="m-2">
          {project.version === "V2" ? (
            <Callout variant={"info"}>This is a v2 project</Callout>
          ) : (
            <Callout variant={"idea"}>This is a v3 project in Developer Preview</Callout>
          )}
        </div>
        <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
          {project.version === "V2" && (
            <SideMenuItem
              to="https://trigger.dev/v3-early-access"
              target="_blank"
              name="Request access to v3"
              icon={V3Icon}
            />
          )}
          {currentPlan?.subscription?.isPaying === true && (
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="small-menu-item"
                  LeadingIcon={SlackIcon}
                  data-action="join our slack"
                  fullWidth
                  textAlignLeft
                >
                  Join our Slack
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>Join our Slack</DialogHeader>
                <div className="mt-2 flex flex-col gap-4">
                  <div className="flex items-center gap-4">
                    <Icon icon={SlackIcon} className="h-10 w-10 min-w-[2.5rem]" />
                    <Paragraph variant="base/bright">
                      As a subscriber, you have access to a dedicated Slack channel for 1-to-1
                      support with the Trigger.dev team.
                    </Paragraph>
                  </div>
                  <hr className="border-charcoal-800" />
                  <div>
                    <StepNumber stepNumber="1" title="Email us" />
                    <StepContentContainer>
                      <Paragraph>
                        Send us an email to this address from your Trigger.dev account email
                        address:
                        <ClipboardField
                          variant="primary/medium"
                          value="priority-support@trigger.dev"
                          className="my-2"
                        />
                      </Paragraph>
                    </StepContentContainer>
                    <StepNumber stepNumber="2" title="Look out for an invite from Slack" />
                    <StepContentContainer>
                      <Paragraph>
                        As soon as we can, we'll setup a Slack Connect channel and say hello!
                      </Paragraph>
                    </StepContentContainer>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}
          <SideMenuItem
            name="Join our Discord"
            icon={DiscordIcon}
            to="https://trigger.dev/discord"
            data-action="join our discord"
            target="_blank"
          />
          {project.version === "V2" ? (
            <SideMenuItem
              name="Documentation"
              icon="docs"
              to="https://trigger.dev/docs"
              data-action="documentation"
              target="_blank"
            />
          ) : (
            <SideMenuItem
              name="Documentation (v3)"
              icon="docs"
              to="https://trigger.dev/docs/v3"
              data-action="documentation"
              target="_blank"
            />
          )}
          <SideMenuItem
            name="Changelog"
            icon="star"
            to="https://trigger.dev/changelog"
            data-action="changelog"
            target="_blank"
          />
          {project.version === "V2" ? (
            <Feedback
              button={
                <Button
                  variant="small-menu-item"
                  LeadingIcon="log"
                  data-action="help & feedback"
                  fullWidth
                  textAlignLeft
                >
                  Help & Feedback
                </Button>
              }
            />
          ) : (
            <Feedback
              defaultValue="developer preview"
              button={
                <Button
                  variant="small-menu-item"
                  LeadingIcon="log"
                  leadingIconClassName="text-primary"
                  data-action="help & feedback"
                  fullWidth
                  textAlignLeft
                >
                  <span className="text-primary">Give feedback on v3</span>
                </Button>
              }
            />
          )}
          {currentPlan && !currentPlan.subscription?.isPaying && currentPlan.usage.runCountCap && (
            <FreePlanUsage
              to={organizationBillingPath(organization)}
              percentage={currentPlan.usage.currentRunCount / currentPlan.usage.runCountCap}
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
                      to={projectPath(organization, p)}
                      title={
                        <div className="flex w-full items-center justify-between text-text-bright">
                          <span className="grow truncate text-left">{p.name}</span>
                          {p.version === "V2" ? (
                            <MenuCount count={p.jobCount} />
                          ) : (
                            <Badge variant="v3">v3</Badge>
                          )}
                        </div>
                      }
                      isSelected={isSelected}
                      icon="folder"
                    />
                  );
                })
              ) : (
                <PopoverMenuItem
                  to={newProjectPath(organization)}
                  title="New project"
                  icon="plus"
                />
              )}
            </div>
          </Fragment>
        ))}
        <div className="border-t border-charcoal-800 p-1">
          <PopoverMenuItem to={newOrganizationPath()} title="New Organization" icon="plus" />
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

function V2ProjectSideMenu({
  project,
  organization,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
}) {
  return (
    <>
      <SideMenuHeader title={"Project"}>
        <PopoverMenuItem
          to={projectSetupPath(organization, project)}
          title="Framework setup"
          icon="plus"
        />
      </SideMenuHeader>
      <SideMenuItem
        name="Jobs"
        icon="job"
        iconColor="text-indigo-500"
        count={project.jobCount}
        to={projectPath(organization, project)}
        data-action="jobs"
      />
      <SideMenuItem
        name="Runs"
        icon="runs"
        iconColor="text-teal-500"
        to={projectRunsPath(organization, project)}
      />
      <SideMenuItem
        name="Triggers"
        icon="trigger"
        iconColor="text-amber-500"
        to={projectTriggersPath(organization, project)}
        data-action="triggers"
        hasWarning={project.hasInactiveExternalTriggers}
      />
      <SideMenuItem
        name="Events"
        icon={CursorArrowRaysIcon}
        iconColor="text-sky-500"
        to={projectEventsPath(organization, project)}
      />
      <SideMenuItem
        name="HTTP endpoints"
        icon="http-endpoint"
        iconColor="text-pink-500"
        count={project.httpEndpointCount}
        to={projectHttpEndpointsPath(organization, project)}
        data-action="httpendpoints"
      />
      <SideMenuItem
        name="Environments & API Keys"
        icon="environment"
        iconColor="text-rose-500"
        to={projectEnvironmentsPath(organization, project)}
        data-action="environments & api keys"
      />
      <SideMenuItem
        name="Project settings"
        icon="settings"
        iconColor="text-teal-500"
        to={projectSettingsPath(organization, project)}
        data-action="project-settings"
      />
    </>
  );
}

function V3ProjectSideMenu({
  project,
  organization,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
}) {
  const { alertsEnabled } = useFeatures();

  return (
    <>
      <SideMenuHeader title={"Project (v3)"} />
      <SideMenuItem
        name="Tasks"
        icon={TaskIcon}
        iconColor="text-blue-500"
        count={project.jobCount}
        to={v3ProjectPath(organization, project)}
        data-action="tasks"
      />
      <SideMenuItem
        name="Runs"
        icon="runs"
        iconColor="text-teal-500"
        to={v3RunsPath(organization, project)}
      />
      <SideMenuItem
        name="Test"
        icon={BeakerIcon}
        iconColor="text-lime-500"
        to={v3TestPath(organization, project)}
        data-action="test"
      />
      <SideMenuItem
        name="Schedules"
        icon={ClockIcon}
        iconColor="text-sun-500"
        to={v3SchedulesPath(organization, project)}
        data-action="schedules"
      />
      <SideMenuItem
        name="API keys"
        icon={KeyIcon}
        iconColor="text-amber-500"
        to={v3ApiKeysPath(organization, project)}
        data-action="api keys"
      />
      <SideMenuItem
        name="Environment variables"
        icon={IdentificationIcon}
        iconColor="text-pink-500"
        to={v3EnvironmentVariablesPath(organization, project)}
        data-action="environment variables"
      />
      <SideMenuItem
        name="Deployments"
        icon={ServerStackIcon}
        iconColor="text-blue-500"
        to={v3DeploymentsPath(organization, project)}
        data-action="deployments"
      />
      {alertsEnabled && (
        <SideMenuItem
          name="Alerts"
          icon={BellAlertIcon}
          iconColor="text-red-500"
          to={v3ProjectAlertsPath(organization, project)}
          data-action="alerts"
        />
      )}
      <SideMenuItem
        name="Project settings"
        icon="settings"
        iconColor="text-teal-500"
        to={v3ProjectSettingsPath(organization, project)}
        data-action="project-settings"
      />
    </>
  );
}

function V3Icon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="16" height="16" rx="8" fill="#A8FF53" />
      <path
        d="M7.7488 6.17L5.5818 12H3.6678L1.5008 6.17H3.2058L4.6248 10.339L6.0328 6.17H7.7488ZM11.0527 7.292C11.6357 7.303 12.2297 7.006 12.2297 6.28C12.2297 5.774 11.7787 5.433 11.0527 5.433C10.4147 5.433 9.98567 5.741 9.91967 6.214L8.22567 6.126C8.36867 4.861 9.51267 4.014 11.0857 4.014C12.8457 4.014 13.9567 4.806 13.9567 6.049C13.9567 6.951 13.3847 7.534 12.3067 7.776C13.5387 8.04 14.2207 8.777 14.2207 9.855C14.2207 11.274 13.0107 12.176 11.0857 12.176C9.32567 12.176 8.12667 11.197 8.04967 9.712L9.75467 9.646C9.83167 10.405 10.4917 10.757 11.0967 10.757C11.8007 10.757 12.4937 10.394 12.4937 9.591C12.4937 8.81 11.7897 8.425 11.0527 8.447L10.3817 8.458V7.281L11.0527 7.292Z"
        fill="#15171A"
      />
    </svg>
  );
}
