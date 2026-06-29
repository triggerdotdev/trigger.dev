import {
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { LinkIcon } from "@heroicons/react/24/solid";
import { useFetcher, useNavigation } from "@remix-run/react";
import { BugIcon } from "~/assets/icons/BugIcon";
import { LayoutGroup, motion } from "framer-motion";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { AIPenIcon } from "~/assets/icons/AIPenIcon";
import { ArrowLeftRightIcon } from "~/assets/icons/ArrowLeftRightIcon";
import { ArrowRightSquareIcon } from "~/assets/icons/ArrowRightSquareIcon";
import { AvatarCircleIcon } from "~/assets/icons/AvatarCircleIcon";
import { HomeIcon } from "~/assets/icons/HomeIcon";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { BatchesIcon } from "~/assets/icons/BatchesIcon";
import { Box3DIcon } from "~/assets/icons/Box3DIcon";
import { ChartBarIcon } from "~/assets/icons/ChartBarIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { FolderClosedIcon } from "~/assets/icons/FolderClosedIcon";
import { FolderOpenIcon } from "~/assets/icons/FolderOpenIcon";
import { IDIcon } from "~/assets/icons/IDIcon";
import { DialIcon } from "~/assets/icons/DialIcon";
import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import { IntegrationsIcon } from "~/assets/icons/IntegrationsIcon";
import { KeyIcon } from "~/assets/icons/KeyIcon";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { LogsIcon } from "~/assets/icons/LogsIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { CodeSquareIcon } from "~/assets/icons/CodeSquareIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { SlidersIcon } from "~/assets/icons/SlidersIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { TasksIcon } from "~/assets/icons/TasksIcon";
import { BellIcon } from "~/assets/icons/BellIcon";
import { UsageIcon } from "~/assets/icons/UsageIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import { CreditCardIcon } from "~/assets/icons/CreditCardIcon";
import { UserGroupIcon } from "~/assets/icons/UserGroupIcon";
import { RolesIcon } from "~/assets/icons/RolesIcon";
import { PadlockIcon } from "~/assets/icons/PadlockIcon";
import { SlackIcon } from "~/assets/icons/SlackIcon";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { Avatar } from "~/components/primitives/Avatar";
import { type MatchedEnvironment } from "~/hooks/useEnvironment";
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { type MatchedProject } from "~/hooks/useProject";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { useHasAdminAccess } from "~/hooks/useUser";
import { type UserWithDashboardPreferences } from "~/models/user.server";
import {
  useCurrentPlan,
  useIsUsingRbacPlugin,
  useIsUsingSsoPlugin,
} from "~/routes/_app.orgs.$organizationSlug/route";
import { type FeedbackType } from "~/routes/resources.feedback";
import { IncidentStatusPanel, useIncidentStatus } from "~/routes/resources.incidents";
import { NotificationPanel } from "./NotificationPanel";
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
  organizationRolesPath,
  organizationSettingsPath,
  organizationSlackIntegrationPath,
  organizationSsoPath,
  organizationTeamPath,
  organizationVercelIntegrationPath,
  queryPath,
  regionsPath,
  v3ApiKeysPath,
  v3BatchesPath,
  v3BillingLimitsPath,
  v3BillingPath,
  v3PrivateConnectionsPath,
  v3DashboardsLandingPath,
  v3BulkActionsPath,
  v3DeploymentsPath,
  v3EnvironmentPath,
  v3EnvironmentVariablesPath,
  v3ErrorsPath,
  v3LogsPath,
  v3PromptsPath,
  v3ModelsPath,
  v3ProjectAlertsPath,
  v3ProjectPath,
  v3ProjectSettingsGeneralPath,
  v3ProjectSettingsIntegrationsPath,
  v3QueuesPath,
  v3RunsPath,
  v3SessionsPath,
  v3UsagePath,
  v3WaitpointTokensPath,
} from "~/utils/pathBuilder";
import { AlphaBadge, NewBadge } from "../FeatureBadges";
import { AskAI } from "../AskAI";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { ConnectionIcon, DevPresencePanel, useDevPresence } from "../DevPresence";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { Button, ButtonContent, LinkButton } from "../primitives/Buttons";
import { Dialog, DialogTrigger } from "../primitives/Dialog";
import { Paragraph } from "../primitives/Paragraph";
import { Badge } from "../primitives/Badge";
import { Popover, PopoverContent, PopoverMenuItem, PopoverTrigger } from "../primitives/Popover";
import { ShortcutKey } from "../primitives/ShortcutKey";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";
import { ShortcutsAutoOpen } from "../Shortcuts";
import { CreateDashboardButton } from "./DashboardDialogs";
import { DashboardList } from "./DashboardList";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";
import { TreeConnectorBranch, TreeConnectorEnd } from "./TreeConnectors";
import { type SideMenuSectionId } from "./sideMenuTypes";

/** Get the collapsed state for a specific side menu section from user preferences */
function getSectionCollapsed(
  sideMenu: { collapsedSections?: Record<string, boolean> } | undefined,
  sectionId: SideMenuSectionId
): boolean {
  return sideMenu?.collapsedSections?.[sectionId] ?? false;
}

// Size the side menu popover items (org menu + project picker) to match the side
// menu items: a 20px leading icon and a 0.90625rem label (vs the smaller
// small-menu-item defaults). The icon class overrides the variant icon size; the
// label class lands on the button element and overrides its text-2sm via
// tailwind-merge. The icon constant also carries the default dimmed color; items
// that need a different icon color (e.g. the indigo project folders) set their own.
const SIDE_MENU_POPOVER_ITEM_ICON = "h-5 w-5 text-text-dimmed";
const SIDE_MENU_POPOVER_ITEM_LABEL = "text-[0.90625rem] font-medium tracking-[-0.01em]";

type SideMenuUser = Pick<
  UserWithDashboardPreferences,
  "email" | "admin" | "dashboardPreferences"
> & {
  isImpersonating: boolean;
};
export type SideMenuProject = Pick<
  MatchedProject,
  "id" | "name" | "slug" | "version" | "environments" | "engine" | "createdAt"
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
    sectionId?: SideMenuSectionId;
    sectionCollapsed?: boolean;
  }>({});
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentPlan = useCurrentPlan();
  const { isConnected } = useDevPresence();
  const isFreeUser = currentPlan?.v3Subscription?.isPaying === false;
  const isAdmin = useHasAdminAccess();
  const { isManagedCloud } = useFeatures();
  const featureFlags = useFeatureFlags();
  const incidentStatus = useIncidentStatus();
  const isV3Project = project.engine === "V1";

  const persistSideMenuPreferences = useCallback(
    (data: {
      isCollapsed?: boolean;
      sectionId?: SideMenuSectionId;
      sectionCollapsed?: boolean;
    }) => {
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
        if (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined) {
          formData.append("sectionId", pending.sectionId);
          formData.append("sectionCollapsed", String(pending.sectionCollapsed));
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
      const hasPendingChanges =
        pending.isCollapsed !== undefined ||
        (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined);

      if (hasPendingChanges) {
        const formData = new FormData();
        if (pending.isCollapsed !== undefined) {
          formData.append("isCollapsed", String(pending.isCollapsed));
        }
        if (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined) {
          formData.append("sectionId", pending.sectionId);
          formData.append("sectionCollapsed", String(pending.sectionCollapsed));
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

  /** Generic handler for any collapsible section - just pass the section ID */
  const handleSectionToggle = useCallback(
    (sectionId: SideMenuSectionId) => (collapsed: boolean) => {
      persistSideMenuPreferences({ sectionId, sectionCollapsed: collapsed });
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
            <OrgSelector
              organizations={organizations}
              organization={organization}
              isCollapsed={isCollapsed}
            />
          </div>
          {isAdmin && !user.isImpersonating ? (
            <CollapsibleElement isCollapsed={isCollapsed}>
              <TooltipProvider disableHoverableContent={true}>
                <Tooltip>
                  <TooltipTrigger>
                    <LinkButton
                      variant="minimal/medium"
                      to={adminPath()}
                      TrailingIcon={HomeIcon}
                      trailingIconClassName="h-4.5 w-4.5"
                      className="h-8 w-8"
                    />
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
              <SideMenuHeader title={"Project"} isCollapsed={isCollapsed} collapsedTitle="Proj" />
              <div>
                <ProjectSelector
                  organization={organization}
                  project={project}
                  isCollapsed={isCollapsed}
                  className="w-full"
                />
                <div className="flex items-center">
                  <EnvironmentSelector
                    organization={organization}
                    project={project}
                    environment={environment}
                    className="w-full"
                    isCollapsed={isCollapsed}
                    showConnector
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
                                ? "Checking connection…"
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
            </div>

            <div className="w-full space-y-0">
              <SideMenuItem
                name="Tasks"
                icon={TasksIcon}
                activeIconColor="text-tasks"
                inactiveIconColor="text-text-dimmed"
                to={v3EnvironmentPath(organization, project, environment)}
                data-action="tasks"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Runs"
                icon={RunsIcon}
                activeIconColor="text-runs"
                inactiveIconColor="text-text-dimmed"
                to={v3RunsPath(organization, project, environment)}
                data-action="runs"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Sessions"
                icon={AIChatIcon}
                activeIconColor="text-sessions"
                inactiveIconColor="text-text-dimmed"
                to={v3SessionsPath(organization, project, environment)}
                data-action="sessions"
                badge={<NewBadge />}
                isCollapsed={isCollapsed}
              />
            </div>

            {(user.admin || user.isImpersonating || featureFlags.hasAiAccess) && (
              <SideMenuSection
                title="AI"
                isSideMenuCollapsed={isCollapsed}
                itemSpacingClassName="space-y-0"
                initialCollapsed={getSectionCollapsed(user.dashboardPreferences.sideMenu, "ai")}
                onCollapseToggle={handleSectionToggle("ai")}
              >
                <SideMenuItem
                  name="Prompts"
                  icon={AIPenIcon}
                  trailingIconClassName="size-6"
                  activeIconColor="text-aiPrompts"
                  inactiveIconColor="text-text-dimmed"
                  to={v3PromptsPath(organization, project, environment)}
                  data-action="prompts"
                  badge={<NewBadge />}
                  isCollapsed={isCollapsed}
                />
                {(user.admin || user.isImpersonating || featureFlags.hasAiAccess) && (
                  <SideMenuItem
                    name="Models"
                    icon={Box3DIcon}
                    activeIconColor="text-models"
                    inactiveIconColor="text-text-dimmed"
                    to={v3ModelsPath(organization, project, environment)}
                    data-action="models"
                    badge={<NewBadge />}
                    isCollapsed={isCollapsed}
                  />
                )}
              </SideMenuSection>
            )}

            {(user.admin || user.isImpersonating || featureFlags.hasQueryAccess) && (
              <SideMenuSection
                title="Observability"
                isSideMenuCollapsed={isCollapsed}
                itemSpacingClassName="space-y-0"
                initialCollapsed={getSectionCollapsed(
                  user.dashboardPreferences.sideMenu,
                  "metrics"
                )}
                onCollapseToggle={handleSectionToggle("metrics")}
              >
                {(user.admin || user.isImpersonating || featureFlags.hasLogsPageAccess) && (
                  <SideMenuItem
                    name="Logs"
                    icon={LogsIcon}
                    activeIconColor="text-logs"
                    inactiveIconColor="text-text-dimmed"
                    to={v3LogsPath(organization, project, environment)}
                    data-action="logs"
                    badge={<AlphaBadge />}
                    isCollapsed={isCollapsed}
                  />
                )}
                <SideMenuItem
                  name="Errors"
                  icon={BugIcon}
                  activeIconColor="text-errors"
                  inactiveIconColor="text-text-dimmed"
                  to={v3ErrorsPath(organization, project, environment)}
                  data-action="errors"
                  isCollapsed={isCollapsed}
                />
                <SideMenuItem
                  name="Query"
                  icon={CodeSquareIcon}
                  activeIconColor="text-query"
                  inactiveIconColor="text-text-dimmed"
                  to={queryPath(organization, project, environment)}
                  data-action="query"
                  isCollapsed={isCollapsed}
                />
                <SideMenuItem
                  name="Queues"
                  icon={QueuesIcon}
                  activeIconColor="text-queues"
                  inactiveIconColor="text-text-dimmed"
                  to={v3QueuesPath(organization, project, environment)}
                  data-action="queues"
                  isCollapsed={isCollapsed}
                />
                <SideMenuItem
                  name="Dashboards"
                  icon={ChartBarIcon}
                  activeIconColor="text-metrics"
                  inactiveIconColor="text-text-dimmed"
                  to={v3DashboardsLandingPath(organization, project, environment)}
                  data-action="dashboards-landing"
                  isCollapsed={isCollapsed}
                  action={
                    <CreateDashboardButton
                      organization={organization}
                      project={project}
                      environment={environment}
                      isCollapsed={isCollapsed}
                    />
                  }
                />
                <DashboardList
                  organization={organization}
                  project={project}
                  environment={environment}
                  isCollapsed={isCollapsed}
                  user={user}
                />
              </SideMenuSection>
            )}

            <SideMenuSection
              title="Deployments"
              isSideMenuCollapsed={isCollapsed}
              itemSpacingClassName="space-y-0"
              initialCollapsed={getSectionCollapsed(
                user.dashboardPreferences.sideMenu,
                "deployments"
              )}
              onCollapseToggle={handleSectionToggle("deployments")}
            >
              <SideMenuItem
                name="Deploys"
                icon={DeploymentsIcon}
                activeIconColor="text-deployments"
                inactiveIconColor="text-text-dimmed"
                to={v3DeploymentsPath(organization, project, environment)}
                data-action="deployments"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Environment variables"
                icon={IDIcon}
                activeIconColor="text-environmentVariables"
                inactiveIconColor="text-text-dimmed"
                to={v3EnvironmentVariablesPath(organization, project, environment)}
                data-action="environment variables"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Preview branches"
                icon={BranchEnvironmentIconSmall}
                activeIconColor="text-previewBranches"
                inactiveIconColor="text-text-dimmed"
                to={branchesPath(organization, project, environment)}
                data-action="preview-branches"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Regions"
                icon={GlobeLinesIcon}
                activeIconColor="text-regions"
                inactiveIconColor="text-text-dimmed"
                to={regionsPath(organization, project, environment)}
                data-action="regions"
                isCollapsed={isCollapsed}
              />
            </SideMenuSection>

            <SideMenuSection
              title="Manage"
              isSideMenuCollapsed={isCollapsed}
              itemSpacingClassName="space-y-0"
              initialCollapsed={getSectionCollapsed(user.dashboardPreferences.sideMenu, "manage")}
              onCollapseToggle={handleSectionToggle("manage")}
            >
              <SideMenuItem
                name="Waitpoint tokens"
                icon={WaitpointTokenIcon}
                activeIconColor="text-sky-500"
                inactiveIconColor="text-text-dimmed"
                to={v3WaitpointTokensPath(organization, project, environment)}
                data-action="waitpoint-tokens"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Batches"
                icon={BatchesIcon}
                activeIconColor="text-batches"
                inactiveIconColor="text-text-dimmed"
                to={v3BatchesPath(organization, project, environment)}
                data-action="batches"
                isCollapsed={isCollapsed}
              />
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
                name="Alerts"
                icon={BellIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ProjectAlertsPath(organization, project, environment)}
                data-action="alerts"
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
                name="Limits"
                icon={DialIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={limitsPath(organization, project, environment)}
                data-action="limits"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Integrations"
                icon={IntegrationsIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ProjectSettingsIntegrationsPath(organization, project, environment)}
                data-action="project-settings-integrations"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Project settings"
                icon={SlidersIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ProjectSettingsGeneralPath(organization, project, environment)}
                data-action="project-settings-general"
                isCollapsed={isCollapsed}
              />
            </SideMenuSection>
          </div>
        </div>
        <div>
          <NotificationPanel
            isCollapsed={isCollapsed}
            hasIncident={incidentStatus.hasIncident}
            organizationId={organization.id}
            projectId={project.id}
          />
          <IncidentStatusPanel
            isCollapsed={isCollapsed}
            title={incidentStatus.title}
            hasIncident={incidentStatus.hasIncident}
            isManagedCloud={incidentStatus.isManagedCloud}
          />
          <V3DeprecationPanel
            isCollapsed={isCollapsed}
            isV3={isV3Project}
            projectCreatedAt={project.createdAt}
            hasIncident={incidentStatus.hasIncident}
            isManagedCloud={incidentStatus.isManagedCloud}
          />
          <motion.div
            layout
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className={cn(
              "flex flex-col gap-1 border-t border-grid-bright p-1",
              isCollapsed && "items-center"
            )}
          >
            <HelpAndAI
              isCollapsed={isCollapsed}
              organizationId={organization.id}
              projectId={project.id}
            />
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

function V3DeprecationPanel({
  isCollapsed,
  isV3,
  projectCreatedAt,
  hasIncident,
  isManagedCloud,
}: {
  isCollapsed: boolean;
  isV3: boolean;
  projectCreatedAt: Date;
  hasIncident: boolean;
  isManagedCloud: boolean;
}) {
  // Only show for projects created before v4 was released
  const V4_RELEASE_DATE = new Date("2025-09-01");
  const isLikelyV3 = isV3 && new Date(projectCreatedAt) < V4_RELEASE_DATE;

  if (!isManagedCloud || !isLikelyV3 || hasIncident) {
    return null;
  }

  return (
    <Popover>
      <div className="p-1">
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? 0 : "auto",
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <V3DeprecationContent />
        </motion.div>

        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? "auto" : 0,
            opacity: isCollapsed ? 1 : 0,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <SimpleTooltip
            button={
              <PopoverTrigger className="flex !h-8 w-full items-center justify-center rounded border border-amber-500/30 bg-amber-500/15 transition-colors hover:border-amber-500/50 hover:bg-amber-500/25">
                <ExclamationTriangleIcon className="size-5 text-amber-400" />
              </PopoverTrigger>
            }
            content="V3 deprecation warning"
            side="right"
            sideOffset={8}
            disableHoverableContent
            asChild
          />
        </motion.div>
      </div>
      <PopoverContent side="right" sideOffset={8} align="start" className="w-52 !min-w-0 p-0">
        <V3DeprecationContent />
      </PopoverContent>
    </Popover>
  );
}

function V3DeprecationContent() {
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 pt-1.5">
      <div className="flex items-center gap-1 border-b border-amber-500/30 pb-1">
        <ExclamationTriangleIcon className="size-4 text-amber-400" />
        <Paragraph variant="small/bright" className="text-amber-300">
          V3 deprecation warning
        </Paragraph>
      </div>
      <Paragraph variant="extra-small/bright" className="text-amber-300">
        This is a v3 project. V3 deploys will stop working on 1 April 2026. Full shutdown is 1 July
        2026 where all v3 runs will stop executing. Migrate to v4 to avoid downtime.
      </Paragraph>
      <LinkButton
        variant="secondary/small"
        to="https://trigger.dev/docs/migrating-from-v3"
        target="_blank"
        fullWidth
        TrailingIcon={ArrowTopRightOnSquareIcon}
        trailingIconClassName="text-amber-300"
        className="border-amber-500/30 bg-amber-500/15 hover:!border-amber-500/50 hover:!bg-amber-500/25"
      >
        <span className="text-amber-300">View migration guide</span>
      </LinkButton>
    </div>
  );
}

function OrgSelector({
  organization,
  organizations,
  isCollapsed = false,
}: {
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  isCollapsed?: boolean;
}) {
  const currentPlan = useCurrentPlan();
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { isManagedCloud } = useFeatures();
  const featureFlags = useFeatureFlags();
  const showSelfServe = useShowSelfServe();
  const isUsingRbacPlugin = useIsUsingRbacPlugin();
  const isUsingSsoPlugin = useIsUsingSsoPlugin();

  const isPaying = currentPlan?.v3Subscription?.isPaying === true;
  const planTitle = currentPlan?.v3Subscription?.plan?.title;

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
                <span className="truncate text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright">
                  {organization.title}
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
        content={organization.title}
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
        <div className="flex flex-col gap-1 p-1">
          <PopoverMenuItem
            to={organizationSettingsPath(organization)}
            title="Settings"
            icon={SlidersIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
          />
          {isManagedCloud && (
            <PopoverMenuItem
              to={v3UsagePath(organization)}
              title="Usage"
              icon={UsageIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isManagedCloud && (
            <PopoverMenuItem
              to={v3BillingPath(organization)}
              title={
                <div className="flex w-full items-center justify-between text-text-bright">
                  <span className="grow truncate text-left">Billing</span>
                  {isPaying && planTitle ? <Badge variant="extra-small">{planTitle}</Badge> : null}
                </div>
              }
              icon={CreditCardIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isManagedCloud && showSelfServe && (
            <PopoverMenuItem
              to={v3BillingLimitsPath(organization)}
              title="Billing alerts"
              icon={BellIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          <PopoverMenuItem
            to={organizationTeamPath(organization)}
            title="Team"
            icon={UserGroupIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
          />
          {featureFlags.hasPrivateConnections && (
            <PopoverMenuItem
              to={v3PrivateConnectionsPath(organization)}
              title="Private connections"
              icon={LinkIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isUsingRbacPlugin && (
            <PopoverMenuItem
              to={organizationRolesPath(organization)}
              title="Roles"
              icon={RolesIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isUsingSsoPlugin && (
            <PopoverMenuItem
              to={organizationSsoPath(organization)}
              title="SSO"
              icon={PadlockIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          <Integrations organization={organization} />
          {organizations.length > 1 ? (
            <SwitchOrganizations organizations={organizations} organization={organization} />
          ) : (
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New organization"
              icon={PlusIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem
            to={accountPath()}
            title="Account"
            icon={AvatarCircleIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
          />
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem
            to={logoutPath()}
            title="Logout"
            icon={ArrowRightSquareIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
            danger
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ProjectSelector({
  project,
  organization,
  isCollapsed = false,
  className,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
  isCollapsed?: boolean;
  className?: string;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    setIsMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setIsMenuOpen(open)} open={isMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded pl-[0.4375rem] transition-colors hover:bg-charcoal-750",
              isCollapsed ? "justify-center pr-0.5" : "justify-between pr-1",
              className
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <FolderOpenIcon className="size-5 shrink-0 text-text-dimmed transition group-hover:text-text-bright" />
              <span
                className={cn(
                  "flex min-w-0 items-center overflow-hidden transition-all duration-200",
                  isCollapsed ? "max-w-0 opacity-0" : "max-w-[200px] opacity-100"
                )}
              >
                <span className="truncate text-[0.90625rem] font-medium tracking-[-0.01em] text-text-dimmed transition group-hover:text-text-bright">
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
        content={project.name ?? "Select a project"}
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        buttonClassName="!h-8"
        asChild
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-[14rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        side={isCollapsed ? "right" : "bottom"}
        sideOffset={isCollapsed ? 8 : 4}
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
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
                icon={isSelected ? FolderOpenIcon : FolderClosedIcon}
                leadingIconClassName="h-5 w-5 text-indigo-500"
                className={SIDE_MENU_POPOVER_ITEM_LABEL}
              />
            );
          })}
          <PopoverMenuItem
            to={newProjectPath(organization)}
            title="New project"
            icon={PlusIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
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
            className={cn("hover:bg-charcoal-750", SIDE_MENU_POPOVER_ITEM_LABEL)}
            LeadingIcon={ArrowLeftRightIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
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
                icon={<Avatar size={1.25} avatar={org.avatar} orgName={org.title} />}
                leadingIconClassName="text-text-dimmed"
                className={SIDE_MENU_POPOVER_ITEM_LABEL}
                isSelected={org.id === organization.id}
              />
            ))}
          </div>
          <div className="border-t border-charcoal-700 p-1">
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New organization"
              icon={PlusIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          </div>
        </PopoverContent>
      </div>
    </Popover>
  );
}

function Integrations({ organization }: { organization: MatchedOrganization }) {
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
            className={cn("hover:bg-charcoal-750", SIDE_MENU_POPOVER_ITEM_LABEL)}
            LeadingIcon={IntegrationsIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            Integrations
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
            <PopoverMenuItem
              to={organizationVercelIntegrationPath(organization)}
              title="Vercel"
              icon={VercelLogo}
              leadingIconClassName="size-4 text-text-dimmed"
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
            <PopoverMenuItem
              to={organizationSlackIntegrationPath(organization)}
              title="Slack"
              icon={SlackIcon}
              leadingIconClassName="size-4 text-text-dimmed"
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          </div>
        </PopoverContent>
      </div>
    </Popover>
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

function HelpAndAI({
  isCollapsed,
  organizationId,
  projectId,
}: {
  isCollapsed: boolean;
  organizationId: string;
  projectId: string;
}) {
  return (
    <LayoutGroup>
      <div
        className={cn(
          "flex w-full",
          isCollapsed ? "flex-col-reverse gap-1" : "items-center justify-between"
        )}
      >
        <ShortcutsAutoOpen />
        <HelpAndFeedback
          isCollapsed={isCollapsed}
          organizationId={organizationId}
          projectId={projectId}
        />
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
      className="pointer-events-none relative z-10 overflow-visible text-charcoal-600 transition-colors group-hover:text-text-bright"
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

function CollapseToggle({ isCollapsed, onToggle }: { isCollapsed: boolean; onToggle: () => void }) {
  const [isHovering, setIsHovering] = useState(false);

  return (
    <div className="absolute -right-3 top-1/2 z-10 -translate-y-1/2">
      {/* Vertical line to mask the side menu border */}
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 h-10 w-px -translate-y-1/2 transition-colors duration-200",
          isHovering ? "bg-charcoal-750" : "bg-background-bright"
        )}
      />
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
