import {
  ArrowPathRoundedSquareIcon,
  ArrowRightOnRectangleIcon,
  BeakerIcon,
  BellAlertIcon,
  BookOpenIcon,
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
import { ConnectedIcon, DisconnectedIcon } from "~/assets/icons/ConnectionIcons";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
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
  docsPath,
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
} from "~/utils/pathBuilder";
import connectedImage from "../../assets/images/cli-connected.png";
import disconnectedImage from "../../assets/images/cli-disconnected.png";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { useDevPresence } from "../DevPresence";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { Button, ButtonContent, LinkButton } from "../primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "../primitives/Dialog";
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
import { PackageManagerProvider, TriggerDevStepV3 } from "../SetupCommands";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";
import { InlineCode } from "../code/InlineCode";

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
        "grid h-full grid-rows-[2.5rem_1fr_auto] overflow-hidden border-r border-grid-bright bg-background-bright transition"
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between border-b px-1 py-1 transition duration-300",
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
            <div className="flex items-center gap-1">
              <EnvironmentSelector
                organization={organization}
                project={project}
                environment={environment}
              />
              {environment.type === "DEVELOPMENT" && <DevConnection />}
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
              name="Runs"
              icon={RunsIcon}
              activeIconColor="text-teal-500"
              to={v3RunsPath(organization, project, environment)}
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
              name="Queues"
              icon={RectangleStackIcon}
              activeIconColor="text-blue-500"
              to={v3QueuesPath(organization, project, environment)}
              data-action="queues"
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
              name="Alerts"
              icon={BellAlertIcon}
              activeIconColor="text-red-500"
              to={v3ProjectAlertsPath(organization, project, environment)}
              data-action="alerts"
            />
            <SideMenuItem
              name="Project settings"
              icon={Cog8ToothIcon}
              activeIconColor="text-teal-500"
              to={v3ProjectSettingsPath(organization, project, environment)}
              data-action="project-settings"
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
        className={cn(
          "h-8 w-full justify-between overflow-hidden py-1 pl-1.5",
          user.isImpersonating && "border border-dashed border-amber-400"
        )}
      >
        <span className="flex items-center gap-1.5 overflow-hidden">
          <Avatar avatar={organization.avatar} className="size-5" />
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
              <Avatar avatar={organization.avatar} className="size-10" includePadding />
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
                    {plan}
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
        <PopoverTrigger className="h-7 w-full justify-between overflow-hidden focus-custom">
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
          <div className="p-1">
            {organizations.map((org) => (
              <PopoverMenuItem
                key={org.id}
                to={organizationPath(org)}
                title={org.title}
                icon={<Avatar className="size-4" avatar={org.avatar} />}
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

export function DevConnection() {
  const { isConnected } = useDevPresence();

  return (
    <Dialog>
      <div>
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <DialogTrigger asChild>
                  <Button
                    variant="minimal/small"
                    className="px-1"
                    LeadingIcon={
                      isConnected ? (
                        <ConnectedIcon className="size-5" />
                      ) : (
                        <DisconnectedIcon className="size-5" />
                      )
                    }
                  />
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className={"text-xs"}>
              {isConnected ? "Your dev server is connected" : "Your dev server is not connected"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <DialogContent>
        <DialogHeader>
          {isConnected ? "Your dev server is connected" : "Your dev server is not connected"}
        </DialogHeader>
        <div className="mt-2 flex flex-col gap-3 px-2">
          <div className="flex flex-col items-center justify-center gap-6 px-6 py-10">
            <img
              src={isConnected ? connectedImage : disconnectedImage}
              alt={isConnected ? "Connected" : "Disconnected"}
              width={282}
              height={45}
            />
            <Paragraph variant="small" className={isConnected ? "text-success" : "text-error"}>
              {isConnected
                ? "Your local dev server is connected to Trigger.dev"
                : "Your local dev server is not connected to Trigger.dev"}
            </Paragraph>
          </div>
          {isConnected ? null : (
            <div className="space-y-3">
              <PackageManagerProvider>
                <TriggerDevStepV3 title="Run this command to connect" />
              </PackageManagerProvider>
              <Paragraph variant="small">
                Run this CLI <InlineCode variant="extra-small">dev</InlineCode> command to connect
                to the Trigger.dev servers to start developing locally. Keep it running while you
                develop to stay connected. Learn more in the{" "}
                <TextLink to={docsPath("cli-dev")}>CLI docs</TextLink>.
              </Paragraph>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
