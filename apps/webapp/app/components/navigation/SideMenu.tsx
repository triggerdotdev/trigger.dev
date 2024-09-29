import {
  AcademicCapIcon,
  ArrowRightOnRectangleIcon,
  ArrowUpRightIcon,
  BeakerIcon,
  BellAlertIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  ChatBubbleLeftEllipsisIcon,
  ClockIcon,
  CreditCardIcon,
  CursorArrowRaysIcon,
  EnvelopeIcon,
  IdentificationIcon,
  KeyIcon,
  LightBulbIcon,
  RectangleStackIcon,
  ServerStackIcon,
  ShieldCheckIcon,
  SignalIcon,
} from "@heroicons/react/20/solid";
import { UserGroupIcon, UserPlusIcon } from "@heroicons/react/24/solid";
import { useNavigation } from "@remix-run/react";
import { DiscordIcon, SlackIcon } from "@trigger.dev/companyicons";
import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
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
import { Feedback } from "../Feedback";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { LogoIcon } from "../LogoIcon";
import { StepContentContainer } from "../StepContentContainer";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { FreePlanUsage } from "../billing/v2/FreePlanUsage";
import { Badge } from "../primitives/Badge";
import { Button, LinkButton } from "../primitives/Buttons";
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
  PopoverSideMenuTrigger,
} from "../primitives/Popover";
import { StepNumber } from "../primitives/StepNumber";
import { TextLink } from "../primitives/TextLink";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";

type SideMenuUser = Pick<User, "email" | "admin"> & { isImpersonating: boolean };
type SideMenuProject = Pick<MatchedProject, "id" | "name" | "slug" | "version">;

type SideMenuProps = {
  user: SideMenuUser;
  project: SideMenuProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  button: ReactNode;
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
              activeIconColor="text-amber-500"
              data-action="team"
            />
            {organization.projects.some((proj) => proj.version === "V3") && isManagedCloud && (
              <>
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
              </>
            )}
            {organization.projects.some((proj) => proj.version === "V2") && (
              <SideMenuItem
                name="Usage (v2)"
                icon={ChartBarIcon}
                to={organizationBillingPath(organization)}
                activeIconColor="text-green-600"
                data-action="usage & billing"
              />
            )}
            <SideMenuItem
              name="Organization settings"
              icon="settings"
              activeIconColor="text-teal-500"
              to={organizationSettingsPath(organization)}
              data-action="organization-settings"
            />
          </div>
        </div>
        <div className="m-2">
          {project.version === "V2" && (
            <div className="flex flex-col gap-3 rounded border border-success/50 bg-success/10 p-3">
              <Paragraph variant="small/bright">
                This is a v2 project. V2 will be deprecated on January 31, 2025.{" "}
                <TextLink
                  className="text-text-bright underline decoration-text-dimmed underline-offset-2 transition hover:text-text-bright hover:decoration-text-bright"
                  to="https://trigger.dev/blog/v2-end-of-life-announcement"
                >
                  Learn more
                </TextLink>
                .
              </Paragraph>
              <LinkButton
                variant="primary/medium"
                to="https://trigger.dev/docs/v3/upgrading-from-v2"
                fullWidth
              >
                Upgrade to v3
              </LinkButton>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
          {currentPlan?.v3Subscription?.plan?.limits.support === "slack" && (
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
          <HelpAndFeedback />
          {isV3Project && isFreeV3User && (
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

function HelpAndFeedback() {
  const [isHelpMenuOpen, setHelpMenuOpen] = useState(false);
  const currentPlan = useCurrentPlan();

  return (
    <Popover onOpenChange={(open) => setHelpMenuOpen(open)}>
      <PopoverSideMenuTrigger isOpen={isHelpMenuOpen} shortcut={{ key: "h" }}>
        <div className="flex items-center gap-1.5">
          <ChatBubbleLeftEllipsisIcon className="size-4 text-success" />
          Help & Feedback
        </div>
      </PopoverSideMenuTrigger>
      <PopoverContent
        className="min-w-[14rem] divide-y divide-grid-bright overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
      >
        <Fragment>
          <div className="flex flex-col gap-1 p-1">
            <SideMenuItem
              name="Documentation"
              icon="docs"
              trailingIcon={ArrowUpRightIcon}
              inactiveIconColor="text-green-500"
              activeIconColor="text-green-500"
              to="https://trigger.dev/docs"
              data-action="documentation"
              target="_blank"
            />
          </div>
          <div className="flex flex-col gap-1 p-1">
            <SideMenuItem
              name="Status"
              icon={SignalIcon}
              trailingIcon={ArrowUpRightIcon}
              inactiveIconColor="text-green-500"
              activeIconColor="text-green-500"
              to="https://status.trigger.dev/"
              data-action="status"
              target="_blank"
            />

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <SideMenuItem
                    name="Suggest a feature"
                    icon={LightBulbIcon}
                    trailingIcon={ArrowUpRightIcon}
                    inactiveIconColor="text-sun-500"
                    activeIconColor="text-sun-500"
                    to="https://feedback.trigger.dev/"
                    data-action="suggest-a-feature"
                    target="_blank"
                  />
                </TooltipTrigger>
                <TooltipContent side="right">
                  Have an idea for a new feature? Let us know!
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <SideMenuItem
              name="Changelog"
              icon="star"
              trailingIcon={ArrowUpRightIcon}
              inactiveIconColor="text-sun-500"
              activeIconColor="text-sun-500"
              to="https://trigger.dev/changelog"
              data-action="changelog"
              target="_blank"
            />
          </div>
          <div className="flex flex-col gap-1 p-1">
            <Paragraph className="pb-1 pl-1.5 pt-1.5 text-2sm">Get in touch</Paragraph>
            {currentPlan?.v3Subscription?.plan?.limits.support !== "slack" && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="small-menu-item"
                          LeadingIcon={SlackIcon}
                          data-action="join-our-slack"
                          fullWidth
                          textAlignLeft
                        >
                          Join our Slack…
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>Join our Slack</DialogHeader>
                        <div className="mt-2 flex flex-col gap-4">
                          <div className="flex items-center gap-4">
                            <Icon icon={SlackIcon} className="h-10 w-10 min-w-[2.5rem]" />
                            <Paragraph variant="base/bright">
                              As a subscriber, you have access to a dedicated Slack channel for
                              1-to-1 support with the Trigger.dev team.
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
                                  variant="secondary/medium"
                                  value="priority-support@trigger.dev"
                                  className="my-2"
                                />
                              </Paragraph>
                            </StepContentContainer>
                            <StepNumber stepNumber="2" title="Look out for an invite from Slack" />
                            <StepContentContainer>
                              <Paragraph>
                                As soon as we can, we'll setup a Slack Connect channel and say
                                hello!
                              </Paragraph>
                            </StepContentContainer>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    Connect with us on Slack for priority support.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <SideMenuItem
                    name="Join our Discord"
                    icon={DiscordIcon}
                    trailingIcon={ArrowUpRightIcon}
                    to="https://trigger.dev/discord"
                    data-action="join our discord"
                    target="_blank"
                  />
                </TooltipTrigger>
                <TooltipContent side="right">
                  The quickest way to get answers from the Trigger.dev community.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <SideMenuItem
                    name="Book a 15 min call"
                    icon={CalendarDaysIcon}
                    trailingIcon={ArrowUpRightIcon}
                    inactiveIconColor="text-rose-500"
                    activeIconColor="text-rose-500"
                    to="https://cal.com/team/triggerdotdev/founders-call"
                    data-action="book-a-call"
                    target="_blank"
                  />
                </TooltipTrigger>
                <TooltipContent side="right">
                  Have a question or want to chat? Book a time to talk with us.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Feedback
              button={
                <Button
                  variant="small-menu-item"
                  LeadingIcon={EnvelopeIcon}
                  leadingIconClassName="text-blue-500"
                  data-action="contact-us"
                  fullWidth
                  textAlignLeft
                >
                  Contact us…
                </Button>
              }
            />
          </div>
        </Fragment>
      </PopoverContent>
    </Popover>
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
                          {p.version === "V2" && (
                            <Badge variant="small" className="normal-case">
                              v2
                            </Badge>
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
        <div className="border-t border-charcoal-700 p-1">
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
      <SideMenuHeader title={"Project (v2)"}>
        <PopoverMenuItem
          to={projectSetupPath(organization, project)}
          title="Framework setup"
          icon="plus"
        />
      </SideMenuHeader>
      <SideMenuItem
        name="Jobs"
        icon="job"
        activeIconColor="text-indigo-500"
        to={projectPath(organization, project)}
        data-action="jobs"
      />
      <SideMenuItem
        name="Runs"
        icon="runs"
        activeIconColor="text-teal-500"
        to={projectRunsPath(organization, project)}
      />
      <SideMenuItem
        name="Triggers"
        icon="trigger"
        activeIconColor="text-amber-500"
        to={projectTriggersPath(organization, project)}
        data-action="triggers"
      />
      <SideMenuItem
        name="Events"
        icon={CursorArrowRaysIcon}
        activeIconColor="text-sky-500"
        to={projectEventsPath(organization, project)}
      />
      <SideMenuItem
        name="HTTP endpoints"
        icon="http-endpoint"
        activeIconColor="text-pink-500"
        to={projectHttpEndpointsPath(organization, project)}
        data-action="httpendpoints"
      />
      <SideMenuItem
        name="Environments & API Keys"
        icon="environment"
        activeIconColor="text-rose-500"
        to={projectEnvironmentsPath(organization, project)}
        data-action="environments & api keys"
      />
      <SideMenuItem
        name="Project settings"
        icon="settings"
        activeIconColor="text-teal-500"
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
        icon="runs"
        activeIconColor="text-teal-500"
        to={v3RunsPath(organization, project)}
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
      {alertsEnabled && (
        <SideMenuItem
          name="Alerts"
          icon={BellAlertIcon}
          activeIconColor="text-red-500"
          to={v3ProjectAlertsPath(organization, project)}
          data-action="alerts"
        />
      )}
      <SideMenuItem
        name="Concurrency limits"
        icon={RectangleStackIcon}
        activeIconColor="text-indigo-500"
        to={v3ConcurrencyPath(organization, project)}
        data-action="concurrency"
      />
      <SideMenuItem
        name="Project settings"
        icon="settings"
        activeIconColor="text-teal-500"
        to={v3ProjectSettingsPath(organization, project)}
        data-action="project-settings"
      />
    </>
  );
}
