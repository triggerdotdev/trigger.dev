import {
  ArrowPathRoundedSquareIcon,
  ArrowRightOnRectangleIcon,
  BeakerIcon,
  BellAlertIcon,
  ChartBarIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog8ToothIcon,
  CogIcon,
  FolderIcon,
  FolderOpenIcon,
  IdentificationIcon,
  KeyIcon,
  PlusIcon,
  RectangleStackIcon,
  ServerStackIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { useNavigation } from "@remix-run/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import simplur from "simplur";
import { RunsIconExtraSmall } from "~/assets/icons/RunsIcon";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import { Avatar } from "~/components/primitives/Avatar";
import { type MatchedEnvironment } from "~/hooks/useEnvironment";
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
  v3ApiKeysPath,
  v3BatchesPath,
  v3BillingPath,
  v3DeploymentsPath,
  v3EnvironmentPath,
  v3EnvironmentVariablesPath,
  v3ProjectAlertsPath,
  v3ProjectPath,
  v3ProjectSettingsPath,
  v3QueuesPath,
  v3RunsPath,
  v3SchedulesPath,
  v3TestPath,
  v3UsagePath,
  v3WaitpointTokensPath,
} from "~/utils/pathBuilder";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { ConnectionIcon, DevPresencePanel, useDevPresence } from "../DevPresence";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { Button, ButtonContent, LinkButton } from "../primitives/Buttons";
import { Dialog, DialogTrigger } from "../primitives/Dialog";
import { Paragraph } from "../primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "../primitives/Popover";
import { TextLink } from "../primitives/TextLink";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { ShortcutKey } from "../primitives/ShortcutKey";

type SideMenuUser = Pick<User, "email" | "admin"> & { isImpersonating: boolean };
export type SideMenuProject = Pick<
  MatchedProject,
  "id" | "name" | "slug" | "version" | "environments" | "engine"
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
  const { isConnected } = useDevPresence();
  const isFreeUser = currentPlan?.v3Subscription?.isPaying === false;
  const buttonRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: { key: "a", modifiers: ["mod", "shift"] },
    action: (e) => {
      e.preventDefault();
      if (buttonRef.current) {
        buttonRef.current.click();
      }
    },
  });

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
        "grid h-full grid-rows-[2.5rem_1fr_auto] overflow-hidden border-r border-grid-bright bg-background-bright transition"
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between overflow-hidden border-b px-1 py-1 transition duration-300",
          showHeaderDivider ? "border-grid-bright" : "border-transparent"
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
        className="overflow-hidden overflow-y-auto pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        ref={borderRef}
      >
        <div className="mb-6 flex flex-col gap-4 px-1">
          <div className="space-y-1">
            <SideMenuHeader title={"Environment"} />
            <div className="flex items-center">
              <EnvironmentSelector
                organization={organization}
                project={project}
                environment={environment}
              />
              {environment.type === "DEVELOPMENT" && project.engine === "V2" && (
                <Dialog>
                  <TooltipProvider disableHoverableContent={true}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="inline-flex">
                          <DialogTrigger asChild>
                            <Button
                              variant="minimal/small"
                              className="aspect-square h-7 p-1"
                              LeadingIcon={<ConnectionIcon isConnected={isConnected} />}
                            />
                          </DialogTrigger>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right" className={"text-xs"}>
                        {isConnected === undefined
                          ? "Checking connection..."
                          : isConnected
                          ? "Your dev server is connected"
                          : "Your dev server is not connected"}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <DevPresencePanel isConnected={isConnected} />
                </Dialog>
              )}
            </div>
          </div>

          <div>
            <SideMenuItem
              name="Tasks"
              icon={TaskIconSmall}
              activeIconColor="text-tasks"
              to={v3EnvironmentPath(organization, project, environment)}
              data-action="tasks"
            />
            <SideMenuItem
              name="Runs"
              icon={RunsIconExtraSmall}
              activeIconColor="text-runs"
              to={v3RunsPath(organization, project, environment)}
            />
            <SideMenuItem
              name="Batches"
              icon={Squares2X2Icon}
              activeIconColor="text-batches"
              to={v3BatchesPath(organization, project, environment)}
              data-action="batches"
            />
            <SideMenuItem
              name="Schedules"
              icon={ClockIcon}
              activeIconColor="text-schedules"
              to={v3SchedulesPath(organization, project, environment)}
              data-action="schedules"
            />
            <SideMenuItem
              name="Queues"
              icon={RectangleStackIcon}
              activeIconColor="text-queues"
              to={v3QueuesPath(organization, project, environment)}
              data-action="queues"
            />
            <SideMenuItem
              name="Deployments"
              icon={ServerStackIcon}
              activeIconColor="text-deployments"
              to={v3DeploymentsPath(organization, project, environment)}
              data-action="deployments"
            />
            <SideMenuItem
              name="Test"
              icon={BeakerIcon}
              activeIconColor="text-tests"
              to={v3TestPath(organization, project, environment)}
              data-action="test"
            />
          </div>

          <SideMenuSection title="Waitpoints">
            <SideMenuItem
              name="Tokens"
              icon={WaitpointTokenIcon}
              activeIconColor="text-sky-500"
              to={v3WaitpointTokensPath(organization, project, environment)}
            />
          </SideMenuSection>

          <SideMenuSection title="Manage">
            <SideMenuItem
              name="API keys"
              icon={KeyIcon}
              activeIconColor="text-apiKeys"
              to={v3ApiKeysPath(organization, project, environment)}
              data-action="api keys"
            />
            <SideMenuItem
              name="Environment variables"
              icon={IdentificationIcon}
              activeIconColor="text-environmentVariables"
              to={v3EnvironmentVariablesPath(organization, project, environment)}
              data-action="environment variables"
            />
            <SideMenuItem
              name="Alerts"
              icon={BellAlertIcon}
              activeIconColor="text-alerts"
              to={v3ProjectAlertsPath(organization, project, environment)}
              data-action="alerts"
            />
            <SideMenuItem
              name="Project settings"
              icon={Cog8ToothIcon}
              activeIconColor="text-projectSettings"
              to={v3ProjectSettingsPath(organization, project, environment)}
              data-action="project-settings"
            />
          </SideMenuSection>
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
        <div className="flex w-full items-center justify-between">
          <HelpAndFeedback />
          <TooltipProvider disableHoverableContent>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Button
                    ref={buttonRef}
                    variant="small-menu-item"
                    data-action="ask-ai"
                    shortcut={{ modifiers: ["mod"], key: "/", enabledOnInputElements: true }}
                    hideShortcutKey
                    data-modal-override-open-class-ask-ai="true"
                    onClick={() => {
                      if (typeof window.Kapa === "function") {
                        window.Kapa("open");
                      }
                    }}
                  >
                    <AISparkleIcon className="size-5" />
                  </Button>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="flex items-center gap-1 py-1.5 pl-2.5 pr-2 text-xs"
              >
                Ask AI
                <ShortcutKey shortcut={{ modifiers: ["mod"], key: "/" }} variant="medium/bright" />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {isFreeUser && (
          <FreePlanUsage
            to={v3BillingPath(organization)}
            percentage={currentPlan.v3Usage.usagePercentage}
          />
        )}
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
    plan = "Free";
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
        className={cn(
          "h-8 w-full justify-between py-1 pl-1.5",
          user.isImpersonating && "border border-dashed border-amber-400"
        )}
      >
        <span className="flex items-center gap-1.5 overflow-hidden">
          <Avatar avatar={organization.avatar} size={1.25} orgName={organization.title} />
          <SelectorDivider />
          <span className="truncate text-2sm font-normal text-text-bright">
            {project.name ?? "Select a project"}
          </span>
        </span>
      </PopoverArrowTrigger>
      <PopoverContent
        className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <div className="flex flex-col gap-2 bg-charcoal-750 p-2">
          <div className="flex items-center gap-2.5">
            <div className="box-content size-10 overflow-clip rounded-sm bg-charcoal-800">
              <Avatar avatar={organization.avatar} size={2.5} orgName={organization.title} />
            </div>
            <div className="space-y-0.5">
              <Paragraph variant="small/bright">{organization.title}</Paragraph>
              <div className="flex items-baseline gap-2">
                {plan && (
                  <TextLink
                    variant="secondary"
                    className="text-xs"
                    to={v3BillingPath(organization)}
                  >
                    {plan} plan
                  </TextLink>
                )}
                <TextLink
                  variant="secondary"
                  className="text-xs"
                  to={organizationTeamPath(organization)}
                >{simplur`${organization.membersCount} member[|s]`}</TextLink>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LinkButton
              variant="secondary/small"
              to={organizationSettingsPath(organization)}
              fullWidth
              iconSpacing="gap-1.5"
              className="group-hover/button:border-charcoal-500"
            >
              <CogIcon className="size-4 text-text-dimmed" />
              <span className="text-text-bright">Settings</span>
            </LinkButton>
            <LinkButton
              variant="secondary/small"
              to={v3UsagePath(organization)}
              fullWidth
              iconSpacing="gap-1.5"
              className="group-hover/button:border-charcoal-500"
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
        <PopoverTrigger className="w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            className="hover:bg-charcoal-750"
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
          alignOffset={0}
          sideOffset={-4}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="flex flex-col gap-1 p-1">
            {organizations.map((org) => (
              <PopoverMenuItem
                key={org.id}
                to={organizationPath(org)}
                title={org.title}
                icon={<Avatar size={1} avatar={org.avatar} orgName={org.title} />}
                leadingIconClassName="text-text-dimmed"
                isSelected={org.id === organization.id}
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
