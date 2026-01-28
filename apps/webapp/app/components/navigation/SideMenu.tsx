import {
  AdjustmentsHorizontalIcon,
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
  GlobeAmericasIcon,
  IdentificationIcon,
  KeyIcon,
  PencilSquareIcon,
  PlusIcon,
  RectangleStackIcon,
  ServerStackIcon,
  Squares2X2Icon,
  TableCellsIcon,
  UsersIcon
} from "@heroicons/react/20/solid";
import { Link, useFetcher, useNavigation } from "@remix-run/react";
import { LayoutGroup, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import simplur from "simplur";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { LogsIcon } from "~/assets/icons/LogsIcon";
import { RunsIconExtraSmall } from "~/assets/icons/RunsIcon";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import { Avatar } from "~/components/primitives/Avatar";
import { type MatchedEnvironment } from "~/hooks/useEnvironment";
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { type MatchedProject } from "~/hooks/useProject";
import { useHasAdminAccess } from "~/hooks/useUser";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { ShortcutKey } from "../primitives/ShortcutKey";
import { type UserWithDashboardPreferences } from "~/models/user.server";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { type FeedbackType } from "~/routes/resources.feedback";
import { IncidentStatusPanel } from "~/routes/resources.incidents";
import { cn } from "~/utils/cn";
import {
  accountPath,
  adminPath,
  branchesPath,
  concurrencyPath,
  limitsPath,
  logoutPath,
  newOrganizationPath,
  newProjectPath,
  organizationPath,
  organizationSettingsPath,
  organizationTeamPath,
  queryPath,
  regionsPath,
  v3ApiKeysPath,
  v3BatchesPath,
  v3BillingPath,
  v3BulkActionsPath,
  v3DeploymentsPath,
  v3EnvironmentPath,
  v3EnvironmentVariablesPath,
  v3LogsPath,
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
import { AlphaBadge } from "../AlphaBadge";
import { AskAI } from "../AskAI";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { ConnectionIcon, DevPresencePanel, useDevPresence } from "../DevPresence";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { Button, ButtonContent, LinkButton } from "../primitives/Buttons";
import { Dialog, DialogTrigger } from "../primitives/Dialog";
import { Paragraph } from "../primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger
} from "../primitives/Popover";
import { TextLink } from "../primitives/TextLink";
import { SimpleTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";
import { ShortcutsAutoOpen } from "../Shortcuts";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";

type SideMenuUser = Pick<UserWithDashboardPreferences, "email" | "admin" | "dashboardPreferences"> & {
  isImpersonating: boolean;
};
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
  const [isCollapsed, setIsCollapsed] = useState(
    user.dashboardPreferences.sideMenu?.isCollapsed ?? false
  );
  const preferencesFetcher = useFetcher();
  const pendingPreferencesRef = useRef<{
    isCollapsed?: boolean;
    manageSectionCollapsed?: boolean;
  }>({});
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentPlan = useCurrentPlan();
  const { isConnected } = useDevPresence();
  const isFreeUser = currentPlan?.v3Subscription?.isPaying === false;
  const isAdmin = useHasAdminAccess();
  const { isManagedCloud } = useFeatures();
  const featureFlags = useFeatureFlags();

  const persistSideMenuPreferences = useCallback(
    (data: { isCollapsed?: boolean; manageSectionCollapsed?: boolean }) => {
      if (user.isImpersonating) return;

      // Merge with any pending changes
      pendingPreferencesRef.current = {
        ...pendingPreferencesRef.current,
        ...data,
      };

      // Clear existing timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Debounce the actual submission by 500ms
      debounceTimeoutRef.current = setTimeout(() => {
        const pending = pendingPreferencesRef.current;
        const formData = new FormData();
        if (pending.isCollapsed !== undefined) {
          formData.append("isCollapsed", String(pending.isCollapsed));
        }
        if (pending.manageSectionCollapsed !== undefined) {
          formData.append("manageSectionCollapsed", String(pending.manageSectionCollapsed));
        }
        preferencesFetcher.submit(formData, {
          method: "POST",
          action: "/resources/preferences/sidemenu",
        });
        pendingPreferencesRef.current = {};
      }, 500);
    },
    [user.isImpersonating, preferencesFetcher]
  );

  // Flush pending preferences on unmount to avoid losing the last toggle
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (user.isImpersonating) return;
      const pending = pendingPreferencesRef.current;
      if (pending.isCollapsed !== undefined || pending.manageSectionCollapsed !== undefined) {
        const formData = new FormData();
        if (pending.isCollapsed !== undefined) {
          formData.append("isCollapsed", String(pending.isCollapsed));
        }
        if (pending.manageSectionCollapsed !== undefined) {
          formData.append("manageSectionCollapsed", String(pending.manageSectionCollapsed));
        }
        preferencesFetcher.submit(formData, {
          method: "POST",
          action: "/resources/preferences/sidemenu",
        });
        pendingPreferencesRef.current = {};
      }
    };
  }, [preferencesFetcher, user.isImpersonating]);

  const handleToggleCollapsed = () => {
    const newIsCollapsed = !isCollapsed;
    setIsCollapsed(newIsCollapsed);
    persistSideMenuPreferences({ isCollapsed: newIsCollapsed });
  };

  const handleManageSectionToggle = useCallback(
    (collapsed: boolean) => {
      persistSideMenuPreferences({ manageSectionCollapsed: collapsed });
    },
    [persistSideMenuPreferences]
  );

  useShortcutKeys({
    shortcut: { modifiers: ["mod"], key: "b", enabledOnInputElements: true },
    action: handleToggleCollapsed,
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
        "relative h-full border-r border-grid-bright bg-background-bright transition-all duration-200",
        isCollapsed ? "w-[2.75rem]" : "w-56"
      )}
    >
      <CollapseToggle isCollapsed={isCollapsed} onToggle={handleToggleCollapsed} />
      <div className="absolute inset-0 grid grid-cols-[100%] grid-rows-[2.5rem_1fr_auto] overflow-hidden">
        <div
          className={cn(
            "flex min-w-0 items-center overflow-hidden border-b px-1 py-1 transition duration-300",
            showHeaderDivider || isCollapsed ? "border-grid-bright" : "border-transparent"
          )}
        >
        <div className={cn("min-w-0", !isCollapsed && "flex-1")}>
          <ProjectSelector
            organizations={organizations}
            organization={organization}
            project={project}
            user={user}
            isCollapsed={isCollapsed}
          />
        </div>
        {isAdmin && !user.isImpersonating ? (
          <CollapsibleElement isCollapsed={isCollapsed}>
            <TooltipProvider disableHoverableContent={true}>
              <Tooltip>
                <TooltipTrigger>
                  <LinkButton variant="minimal/medium" to={adminPath()} TrailingIcon={UsersIcon} />
                </TooltipTrigger>
                <TooltipContent side="bottom" className={"text-xs"}>
                  Admin dashboard
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </CollapsibleElement>
        ) : isAdmin && user.isImpersonating ? (
          <CollapsibleElement isCollapsed={isCollapsed}>
            <ImpersonationBanner />
          </CollapsibleElement>
        ) : null}
      </div>
      <div
        className={cn(
          "min-h-0 overflow-y-auto pt-2",
          isCollapsed
            ? "scrollbar-none"
            : "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        )}
        ref={borderRef}
      >
        <div className="mb-6 flex w-full flex-col gap-4 overflow-hidden px-1">
          <div className="w-full space-y-1">
            <SideMenuHeader title={"Environment"} isCollapsed={isCollapsed} collapsedTitle="Env" />
            <div className="flex items-center">
              <EnvironmentSelector
                organization={organization}
                project={project}
                environment={environment}
                className="w-full"
                isCollapsed={isCollapsed}
              />
              {environment.type === "DEVELOPMENT" && project.engine === "V2" && (
                <CollapsibleElement isCollapsed={isCollapsed}>
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
                </CollapsibleElement>
              )}
            </div>
          </div>

          <div className="w-full">
            <SideMenuItem
              name="Tasks"
              icon={TaskIconSmall}
              activeIconColor="text-tasks"
              inactiveIconColor="text-tasks"
              to={v3EnvironmentPath(organization, project, environment)}
              data-action="tasks"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Runs"
              icon={RunsIconExtraSmall}
              activeIconColor="text-runs"
              inactiveIconColor="text-runs"
              to={v3RunsPath(organization, project, environment)}
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Batches"
              icon={Squares2X2Icon}
              activeIconColor="text-batches"
              inactiveIconColor="text-batches"
              to={v3BatchesPath(organization, project, environment)}
              data-action="batches"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Schedules"
              icon={ClockIcon}
              activeIconColor="text-schedules"
              inactiveIconColor="text-schedules"
              to={v3SchedulesPath(organization, project, environment)}
              data-action="schedules"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Queues"
              icon={RectangleStackIcon}
              activeIconColor="text-queues"
              inactiveIconColor="text-queues"
              to={v3QueuesPath(organization, project, environment)}
              data-action="queues"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Waitpoint tokens"
              icon={WaitpointTokenIcon}
              activeIconColor="text-sky-500"
              inactiveIconColor="text-sky-500"
              to={v3WaitpointTokensPath(organization, project, environment)}
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Deployments"
              icon={ServerStackIcon}
              activeIconColor="text-deployments"
              inactiveIconColor="text-deployments"
              to={v3DeploymentsPath(organization, project, environment)}
              data-action="deployments"
              isCollapsed={isCollapsed}
            />
            {(user.admin || user.isImpersonating || featureFlags.hasLogsPageAccess) && (
              <SideMenuItem
                name="Logs"
                icon={LogsIcon}
                activeIconColor="text-logs"
                inactiveIconColor="text-logs"
                to={v3LogsPath(organization, project, environment)}
                data-action="logs"
                badge={<AlphaBadge />}
                isCollapsed={isCollapsed}
              />
            )}
            <SideMenuItem
              name="Test"
              icon={BeakerIcon}
              activeIconColor="text-tests"
              inactiveIconColor="text-tests"
              to={v3TestPath(organization, project, environment)}
              data-action="test"
              isCollapsed={isCollapsed}
            />
            {(user.admin || user.isImpersonating || featureFlags.hasQueryAccess) && (
              <SideMenuItem
                name="Query"
                icon={TableCellsIcon}
                activeIconColor="text-purple-500"
                inactiveIconColor="text-purple-500"
                to={queryPath(organization, project, environment)}
                data-action="query"
                badge={<AlphaBadge />}
                isCollapsed={isCollapsed}
              />
            )}
          </div>

          <SideMenuSection
            title="Manage"
            isSideMenuCollapsed={isCollapsed}
            itemSpacingClassName="space-y-0"
            initialCollapsed={user.dashboardPreferences.sideMenu?.manageSectionCollapsed ?? false}
            onCollapseToggle={handleManageSectionToggle}
          >
            <SideMenuItem
              name="Bulk actions"
              icon={ListCheckedIcon}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={v3BulkActionsPath(organization, project, environment)}
              data-action="bulk actions"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="API keys"
              icon={KeyIcon}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={v3ApiKeysPath(organization, project, environment)}
              data-action="api keys"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Environment variables"
              icon={IdentificationIcon}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={v3EnvironmentVariablesPath(organization, project, environment)}
              data-action="environment variables"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Alerts"
              icon={BellAlertIcon}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={v3ProjectAlertsPath(organization, project, environment)}
              data-action="alerts"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Preview branches"
              icon={BranchEnvironmentIconSmall}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={branchesPath(organization, project, environment)}
              data-action="preview-branches"
              isCollapsed={isCollapsed}
            />
            {isManagedCloud && (
              <SideMenuItem
                name="Concurrency"
                icon={ConcurrencyIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={concurrencyPath(organization, project, environment)}
                data-action="concurrency"
                isCollapsed={isCollapsed}
              />
            )}
            <SideMenuItem
              name="Regions"
              icon={GlobeAmericasIcon}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={regionsPath(organization, project, environment)}
              data-action="regions"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Limits"
              icon={AdjustmentsHorizontalIcon}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={limitsPath(organization, project, environment)}
              data-action="limits"
              isCollapsed={isCollapsed}
            />
            <SideMenuItem
              name="Project settings"
              icon={Cog8ToothIcon}
              activeIconColor="text-text-bright"
              inactiveIconColor="text-text-dimmed"
              to={v3ProjectSettingsPath(organization, project, environment)}
              data-action="project-settings"
              isCollapsed={isCollapsed}
            />
          </SideMenuSection>
        </div>
      </div>
      <div>
        <IncidentStatusPanel isCollapsed={isCollapsed} />
        <motion.div
          layout
          transition={{ duration: 0.2, ease: "easeInOut" }}
          className={cn("flex flex-col gap-1 border-t border-grid-bright p-1", isCollapsed && "items-center")}
        >
          <HelpAndAI isCollapsed={isCollapsed} />
          {isFreeUser && (
            <CollapsibleHeight isCollapsed={isCollapsed}>
              <FreePlanUsage
                to={v3BillingPath(organization)}
                percentage={currentPlan.v3Usage.usagePercentage}
              />
            </CollapsibleHeight>
          )}
        </motion.div>
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
  isCollapsed = false,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  user: SideMenuUser;
  isCollapsed?: boolean;
}) {
  const currentPlan = useCurrentPlan();
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { isManagedCloud } = useFeatures();

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
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded pl-[0.4375rem] transition-colors hover:bg-charcoal-750",
              isCollapsed ? "justify-center pr-0.5" : "w-full justify-between pr-1"
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <Avatar avatar={organization.avatar} size={1.25} orgName={organization.title} />
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 overflow-hidden transition-all duration-200",
                  isCollapsed ? "max-w-0 opacity-0" : "max-w-[200px] opacity-100"
                )}
              >
                <SelectorDivider />
                <span className="truncate text-2sm font-normal text-text-bright">
                  {project.name ?? "Select a project"}
                </span>
              </span>
            </span>
            <span
              className={cn(
                "overflow-hidden transition-all duration-200",
                isCollapsed ? "max-w-0 opacity-0" : "max-w-[16px] opacity-100"
              )}
            >
              <DropdownIcon className="size-4 min-w-4 text-text-dimmed transition group-hover:text-text-bright" />
            </span>
          </PopoverTrigger>
        }
        content={`${organization.title} / ${project.name ?? "Select a project"}`}
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        buttonClassName="!h-8"
        asChild
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        side={isCollapsed ? "right" : "bottom"}
        sideOffset={isCollapsed ? 8 : 4}
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <div className="flex flex-col gap-2 bg-charcoal-750 p-2">
          <div className="flex items-center gap-2.5">
            <Link
              to={organizationSettingsPath(organization)}
              className="group relative box-content size-10 overflow-clip rounded-sm bg-charcoal-800"
            >
              <Avatar avatar={organization.avatar} size={2.5} orgName={organization.title} />
              <div className="absolute inset-0 z-10 grid h-full w-full place-items-center bg-black/50 opacity-0 transition group-hover:opacity-100">
                <PencilSquareIcon className="size-5 text-text-bright" />
              </div>
            </Link>
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
            {isManagedCloud && (
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
            )}
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
          {organizations.length > 1 ? (
            <SwitchOrganizations organizations={organizations} organization={organization} />
          ) : (
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New organization"
              icon={PlusIcon}
              leadingIconClassName="text-text-dimmed"
            />
          )}
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem
            to={accountPath()}
            title="Account"
            icon={UserProfilePhoto}
            leadingIconClassName="text-text-dimmed rounded-full border border-transparent"
          />
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
      <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="flex">
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
              title="New organization"
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

/** Helper component that fades out but preserves width (collapses to 0 width) */
function CollapsibleElement({
  isCollapsed,
  children,
  className,
}: {
  isCollapsed: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden transition-all duration-200",
        isCollapsed ? "max-w-0 opacity-0" : "max-w-[100px] opacity-100",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Helper component that fades out and collapses height completely */
function CollapsibleHeight({
  isCollapsed,
  children,
  className,
}: {
  isCollapsed: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid transition-all duration-200 ease-in-out",
        isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        className
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function HelpAndAI({ isCollapsed }: { isCollapsed: boolean }) {
  return (
    <LayoutGroup>
      <div className={cn("flex w-full", isCollapsed ? "flex-col-reverse gap-1" : "items-center justify-between")}>
        <ShortcutsAutoOpen />
        <HelpAndFeedback isCollapsed={isCollapsed} />
        <AskAI isCollapsed={isCollapsed} />
      </div>
    </LayoutGroup>
  );
}

function AnimatedChevron({
  isHovering,
  isCollapsed,
}: {
  isHovering: boolean;
  isCollapsed: boolean;
}) {
  // When hovering and expanded: left chevron (pointing left to collapse)
  // When hovering and collapsed: right chevron (pointing right to expand)
  // When not hovering: straight vertical line
  
  const getRotation = () => {
    if (!isHovering) return { top: 0, bottom: 0 };
    if (isCollapsed) {
      // Right chevron
      return { top: -17, bottom: 17 };
    } else {
      // Left chevron
      return { top: 17, bottom: -17 };
    }
  };

  const { top, bottom } = getRotation();
  
  // Calculate horizontal offset to keep chevron centered when rotated
  // Left chevron: translate left (-1.5px)
  // Right chevron: translate right (+1.5px)
  const getTranslateX = () => {
    if (!isHovering) return 0;
    return isCollapsed ? 1.5 : -1.5;
  };

  return (
    <motion.svg
      width="4"
      height="30"
      viewBox="0 0 4 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pointer-events-none relative z-10 overflow-visible text-charcoal-600 group-hover:text-text-bright transition-colors"
      initial={false}
      animate={{
        x: getTranslateX(),
      }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* Top segment */}
      <motion.line
        x1="2"
        y1="1.5"
        x2="2"
        y2="15"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        initial={false}
        animate={{
          rotate: top,
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={{ transformOrigin: "2px 15px" }}
      />
      {/* Bottom segment */}
      <motion.line
        x1="2"
        y1="15"
        x2="2"
        y2="28.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        initial={false}
        animate={{
          rotate: bottom,
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={{ transformOrigin: "2px 15px" }}
      />
    </motion.svg>
  );
}

function CollapseToggle({
  isCollapsed,
  onToggle,
}: {
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const [isHovering, setIsHovering] = useState(false);

  return (
    <div className="absolute -right-3 top-1/2 z-10 -translate-y-1/2">
      {/* Vertical line to mask the side menu border */}
      <div className={cn(
        "pointer-events-none absolute left-1/2 top-1/2 h-10 w-px -translate-y-1/2 transition-colors duration-200",
        isHovering ? "bg-charcoal-750" : "bg-background-bright"
      )} />
      <TooltipProvider disableHoverableContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={isCollapsed ? "Expand side menu" : "Collapse side menu"}
              onClick={onToggle}
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={() => setIsHovering(false)}
              className={cn(
                "group flex h-12 w-6 items-center justify-center rounded-md text-text-dimmed transition-all duration-200 focus-custom",
                isHovering
                  ? "border border-grid-bright bg-background-bright shadow-md hover:bg-charcoal-750 hover:text-text-bright"
                  : "border border-transparent bg-transparent"
              )}
            >
              <AnimatedChevron isHovering={isHovering} isCollapsed={isCollapsed} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="flex items-center gap-2 text-xs">
            {isCollapsed ? "Expand" : "Collapse"}
            <span className="flex items-center">
              <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
              <ShortcutKey shortcut={{ key: "b" }} variant="medium/bright" />
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
