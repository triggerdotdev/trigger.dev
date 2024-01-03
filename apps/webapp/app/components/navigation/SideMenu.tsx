import {
  AcademicCapIcon,
  ArrowRightIcon,
  ArrowRightOnRectangleIcon,
  ChartBarIcon,
  EllipsisHorizontalIcon,
} from "@heroicons/react/20/solid";
import { UserGroupIcon, UserPlusIcon } from "@heroicons/react/24/solid";
import { useNavigation } from "@remix-run/react";
import { IconExclamationCircle } from "@tabler/icons-react";
import { DiscordIcon, SlackIcon } from "@trigger.dev/companyicons";
import { AnchorHTMLAttributes, Fragment, useEffect, useRef, useState } from "react";
import { useFeatures } from "~/hooks/useFeatures";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
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
  organizationTeamPath,
  projectEnvironmentsPath,
  projectHttpEndpointsPath,
  projectPath,
  projectRunsPath,
  projectSetupPath,
  projectTriggersPath,
} from "~/utils/pathBuilder";
import { Feedback } from "../Feedback";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { LogoIcon } from "../LogoIcon";
import { StepContentContainer } from "../StepContentContainer";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { Button, LinkButton } from "../primitives/Buttons";
import { ClipboardField } from "../primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { Icon } from "../primitives/Icon";
import { type IconNames } from "../primitives/NamedIcon";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";

type SideMenuUser = Pick<User, "email" | "admin"> & { isImpersonating: boolean };
type SideMenuProject = Pick<
  MatchedProject,
  "id" | "name" | "slug" | "hasInactiveExternalTriggers" | "jobCount" | "httpEndpointCount"
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
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-ui-border transition"
      )}
    >
      <div className="flex h-full flex-col">
        <div
          className={cn(
            "flex items-center justify-between border-b bg-background px-1 py-1 transition",
            showHeaderDivider ? " border-border" : "border-transparent"
          )}
        >
          <ProjectSelector
            organization={organization}
            organizations={organizations}
            project={project}
          />
          <UserMenu user={user} />
        </div>
        <div
          className="h-full overflow-hidden overflow-y-auto pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          ref={borderRef}
        >
          <div className="mb-6 flex flex-col gap-1 px-1">
            <SideMenuHeader title={project.name || "No project found"}>
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
          </div>
          <div className="mb-1 flex flex-col gap-1 px-1">
            <SideMenuHeader title={organization.title}>
              <PopoverMenuItem to={newProjectPath(organization)} title="New Project" icon="plus" />
              <PopoverMenuItem
                to={inviteTeamMemberPath(organization)}
                title="Invite team member"
                icon={UserPlusIcon}
                leadingIconClassName="text-indigo-500"
              />
            </SideMenuHeader>
            <SideMenuItem
              name="Integrations"
              icon="integration"
              to={organizationIntegrationsPath(organization)}
              data-action="integrations"
              hasWarning={organization.hasUnconfiguredIntegrations}
            />
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
              name={isManagedCloud ? "Usage & Billing" : "Usage"}
              icon={ChartBarIcon}
              to={organizationBillingPath(organization)}
              iconColor="text-green-600"
              data-action="usage & billing"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-border p-1">
          {currentPlan?.subscription?.isPaying === true ? (
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
                  <hr className="border-slate-800" />
                  <div>
                    <StepNumber stepNumber="1" title="Create a new Slack channel" />
                    <StepContentContainer>
                      <Paragraph>
                        In your Slack app, create a new channel from the main menu by going to File{" "}
                        <ArrowRightIcon className="inline h-4 w-4 text-dimmed" /> New Channel
                      </Paragraph>
                    </StepContentContainer>
                    <StepNumber stepNumber="2" title="Setup your channel" />
                    <StepContentContainer>
                      <Paragraph>
                        Name your channel, set its visibility and click 'Create'.
                      </Paragraph>
                    </StepContentContainer>
                    <StepNumber stepNumber="3" title="Invite Trigger.dev" />
                    <StepContentContainer>
                      <Paragraph>
                        Invite this email address to your channel:{" "}
                        <ClipboardField
                          variant="primary/medium"
                          value="james@trigger.dev"
                          className="my-2"
                        />
                      </Paragraph>
                      <Paragraph>
                        As soon as we can, we'll accept your invitation and say hello!
                      </Paragraph>
                    </StepContentContainer>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          ) : (
            <SideMenuItem
              name="Join our Discord"
              icon={DiscordIcon}
              to="https://trigger.dev/discord"
              data-action="join our discord"
              target="_blank"
            />
          )}

          <SideMenuItem
            name="Documentation"
            icon="docs"
            to="https://trigger.dev/docs"
            data-action="documentation"
            target="_blank"
          />
          <SideMenuItem
            name="Changelog"
            icon="star"
            to="https://trigger.dev/changelog"
            data-action="changelog"
            target="_blank"
          />

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
  organization,
  organizations,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
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
        <span className="truncate">{organization.title ?? "Select an organization"}</span>
      </PopoverArrowTrigger>
      <PopoverContent
        className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        {organizations.map((organization) => (
          <Fragment key={organization.id}>
            <PopoverSectionHeader title={organization.title} />
            <div className="flex flex-col gap-1 p-1">
              {organization.projects.map((p) => {
                const isSelected = p.id === project.id;
                return (
                  <PopoverMenuItem
                    key={p.id}
                    to={projectPath(organization, p)}
                    title={
                      <div className="flex w-full items-center justify-between text-bright">
                        <span className="grow truncate text-left">{p.name}</span>
                        <MenuCount count={p.jobCount} />
                      </div>
                    }
                    isSelected={isSelected}
                    icon="folder"
                  />
                );
              })}
            </div>
          </Fragment>
        ))}
        <div className="border-t border-slate-800 p-1">
          <PopoverMenuItem to={newOrganizationPath()} title="New Organization" icon="plus" />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu({ user }: { user: SideMenuUser }) {
  const [isProfileMenuOpen, setProfileMenuOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    setProfileMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setProfileMenuOpen(open)}>
      <PopoverCustomTrigger isOpen={isProfileMenuOpen} className="p-1">
        <UserProfilePhoto
          className={cn(
            "h-5 w-5 text-slate-600",
            user.isImpersonating && "rounded-full border border-yellow-500"
          )}
        />
      </PopoverCustomTrigger>
      <PopoverContent
        className="min-w-[12rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
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

function SideMenuHeader({ title, children }: { title: string; children: React.ReactNode }) {
  const [isHeaderMenuOpen, setHeaderMenuOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    setHeaderMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <div className="group flex items-center justify-between pl-1.5">
      <Paragraph
        variant="extra-extra-small/caps"
        className="cursor-default truncate text-slate-500"
      >
        {title}
      </Paragraph>
      <Popover onOpenChange={(open) => setHeaderMenuOpen(open)} open={isHeaderMenuOpen}>
        <PopoverCustomTrigger className="p-1">
          <EllipsisHorizontalIcon className="h-4 w-4 text-slate-500 transition group-hover:text-bright" />
        </PopoverCustomTrigger>
        <PopoverContent
          className="min-w-max overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="start"
        >
          <div className="flex flex-col gap-1 p-1">{children}</div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SideMenuItem({
  icon,
  iconColor,
  name,
  to,
  hasWarning,
  count,
  target,
  subItem = false,
}: {
  icon?: IconNames | React.ComponentType<any>;
  iconColor?: string;
  name: string;
  to: string;
  hasWarning?: string | boolean;
  count?: number;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  subItem?: boolean;
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

  return (
    <LinkButton
      variant={subItem ? "small-menu-sub-item" : "small-menu-item"}
      fullWidth
      textAlignLeft
      LeadingIcon={icon}
      leadingIconClassName={isActive ? iconColor : "text-dimmed"}
      to={to}
      target={target}
      className={cn(
        "text-bright group-hover:bg-slate-850",
        subItem ? "text-dimmed" : "",
        isActive ? "bg-slate-850 text-bright" : "group-hover:text-bright"
      )}
    >
      <div className="flex w-full items-center justify-between">
        {name}
        <div className="flex items-center gap-1">
          {count !== undefined && count > 0 && <MenuCount count={count} />}
          {typeof hasWarning === "string" ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon={IconExclamationCircle} className="h-5 w-5 text-rose-500" />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1 border border-rose-500 bg-rose-500/20 backdrop-blur-xl">
                  {hasWarning}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            hasWarning && <Icon icon={IconExclamationCircle} className="h-5 w-5 text-rose-500" />
          )}
        </div>
      </div>
    </LinkButton>
  );
}

function MenuCount({ count }: { count: number | string }) {
  return <div className="rounded-full bg-slate-900 px-2 py-1 text-xxs text-dimmed">{count}</div>;
}
