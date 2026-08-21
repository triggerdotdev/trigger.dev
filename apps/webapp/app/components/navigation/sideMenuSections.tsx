import { type ReactNode } from "react";
import { AIPenIcon } from "~/assets/icons/AIPenIcon";
import { BatchesIcon } from "~/assets/icons/BatchesIcon";
import { BellIcon } from "~/assets/icons/BellIcon";
import { Box3DIcon } from "~/assets/icons/Box3DIcon";
import { BugIcon } from "~/assets/icons/BugIcon";
import { ChartBarIcon } from "~/assets/icons/ChartBarIcon";
import { CodeSquareIcon } from "~/assets/icons/CodeSquareIcon";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { DialIcon } from "~/assets/icons/DialIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import { IDIcon } from "~/assets/icons/IDIcon";
import { IntegrationsIcon } from "~/assets/icons/IntegrationsIcon";
import { KeyIcon } from "~/assets/icons/KeyIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { LogsIcon } from "~/assets/icons/LogsIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import {
  type EnvironmentForPath,
  type OrgForPath,
  type ProjectForPath,
  branchesPath,
  concurrencyPath,
  limitsPath,
  queryPath,
  regionsPath,
  v3ApiKeysPath,
  v3BatchesPath,
  v3BulkActionsPath,
  v3DashboardsLandingPath,
  v3DeploymentsPath,
  v3EnvironmentVariablesPath,
  v3ErrorsPath,
  v3LogsPath,
  v3ModelsPath,
  v3ProjectAlertsPath,
  v3ProjectSettingsIntegrationsPath,
  v3PromptsPath,
  v3QueuesPath,
  v3WaitpointTokensPath,
} from "~/utils/pathBuilder";
import { AlphaBadge, NewBadge } from "../FeatureBadges";
import { type RenderIcon } from "../primitives/Icon";
import { type SideMenuSectionId } from "./sideMenuTypes";

// The side menu's customizable sections, in DEFAULT order. Outside SideMenu so
// the profile page can build the same list without one to read from.

type SideMenuItemConfig = {
  /** Stable id used for hidden/order preferences; never rename once shipped. */
  id: string;
  name: string;
  icon: RenderIcon;
  activeIconColor: string;
  inactiveIconColor?: string;
  to: string;
  dataAction?: string;
  badge?: ReactNode;
  trailingIconClassName?: string;
  /** Hidden for every user who hasn't set their own preference for this item. */
  defaultHidden?: boolean;
  /** Right-side action (e.g. the + button on Dashboards); only rendered when visible. */
  action?: ReactNode;
  /** Extra content rendered directly after the item (e.g. the dashboards list). */
  after?: ReactNode;
};

export type SideMenuSectionConfig = {
  id: SideMenuSectionId;
  title: string;
  items: SideMenuItemConfig[];
};

export function buildSideMenuSections({
  organization,
  project,
  environment,
  isAdmin,
  featureFlags,
  isManagedCloud,
  dashboards,
}: {
  organization: OrgForPath;
  project: ProjectForPath;
  environment: EnvironmentForPath;
  isAdmin: boolean;
  featureFlags: { hasAiAccess?: boolean; hasQueryAccess?: boolean; hasLogsPageAccess?: boolean };
  isManagedCloud: boolean;
  /** Side-menu-only extras on the Dashboards item; the customize modal has no use for them. */
  dashboards?: { action?: ReactNode; after?: ReactNode };
}): SideMenuSectionConfig[] {
  const staticSections: SideMenuSectionConfig[] = [];

  if (isAdmin || featureFlags.hasAiAccess) {
    staticSections.push({
      id: "ai",
      title: "AI",
      items: [
        {
          id: "prompts",
          name: "Prompts",
          icon: AIPenIcon,
          trailingIconClassName: "size-6",
          activeIconColor: "text-aiPrompts",
          to: v3PromptsPath(organization, project, environment),
          dataAction: "prompts",
          badge: <NewBadge />,
        },
        {
          id: "models",
          name: "Models",
          icon: Box3DIcon,
          activeIconColor: "text-models",
          to: v3ModelsPath(organization, project, environment),
          dataAction: "models",
          badge: <NewBadge />,
        },
      ],
    });
  }

  if (isAdmin || featureFlags.hasQueryAccess) {
    staticSections.push({
      id: "metrics",
      title: "Observability",
      items: [
        ...(isAdmin || featureFlags.hasLogsPageAccess
          ? [
              {
                id: "logs",
                name: "Logs",
                icon: LogsIcon,
                activeIconColor: "text-logs",
                to: v3LogsPath(organization, project, environment),
                dataAction: "logs",
                badge: <AlphaBadge />,
              } satisfies SideMenuItemConfig,
            ]
          : []),
        {
          id: "errors",
          name: "Errors",
          icon: BugIcon,
          activeIconColor: "text-errors",
          to: v3ErrorsPath(organization, project, environment),
          dataAction: "errors",
        },
        {
          id: "query",
          name: "Query",
          icon: CodeSquareIcon,
          activeIconColor: "text-query",
          to: queryPath(organization, project, environment),
          dataAction: "query",
        },
        {
          id: "queues",
          name: "Queues",
          icon: QueuesIcon,
          activeIconColor: "text-queues",
          to: v3QueuesPath(organization, project, environment),
          dataAction: "queues",
        },
        {
          id: "dashboards",
          name: "Dashboards",
          icon: ChartBarIcon,
          activeIconColor: "text-metrics",
          to: v3DashboardsLandingPath(organization, project, environment),
          dataAction: "dashboards-landing",
          action: dashboards?.action,
          after: dashboards?.after,
        },
      ],
    });
  }

  staticSections.push({
    id: "deployments",
    title: "Deployments",
    items: [
      {
        id: "deployments",
        name: "Deploys",
        icon: DeploymentsIcon,
        activeIconColor: "text-deployments",
        to: v3DeploymentsPath(organization, project, environment),
        dataAction: "deployments",
      },
      {
        id: "environment-variables",
        name: "Environment variables",
        icon: IDIcon,
        activeIconColor: "text-environmentVariables",
        to: v3EnvironmentVariablesPath(organization, project, environment),
        dataAction: "environment variables",
      },
      {
        id: "preview-branches",
        name: "Preview branches",
        icon: BranchEnvironmentIconSmall,
        activeIconColor: "text-previewBranches",
        to: branchesPath(organization, project, environment),
        dataAction: "preview-branches",
      },
      {
        id: "regions",
        name: "Regions",
        icon: GlobeLinesIcon,
        activeIconColor: "text-regions",
        to: regionsPath(organization, project, environment),
        dataAction: "regions",
      },
    ],
  });

  staticSections.push({
    id: "manage",
    title: "Manage",
    items: [
      {
        id: "waitpoint-tokens",
        name: "Waitpoint tokens",
        icon: WaitpointTokenIcon,
        activeIconColor: "text-sky-500",
        to: v3WaitpointTokensPath(organization, project, environment),
        dataAction: "waitpoint-tokens",
      },
      {
        id: "batches",
        name: "Batches",
        icon: BatchesIcon,
        activeIconColor: "text-batches",
        to: v3BatchesPath(organization, project, environment),
        dataAction: "batches",
      },
      {
        id: "bulk-actions",
        name: "Bulk actions",
        icon: ListCheckedIcon,
        activeIconColor: "text-text-bright",
        to: v3BulkActionsPath(organization, project, environment),
        dataAction: "bulk actions",
      },
      {
        id: "api-keys",
        name: "API keys",
        icon: KeyIcon,
        activeIconColor: "text-text-bright",
        to: v3ApiKeysPath(organization, project, environment),
        dataAction: "api keys",
      },
      {
        id: "alerts",
        name: "Alerts",
        icon: BellIcon,
        activeIconColor: "text-text-bright",
        to: v3ProjectAlertsPath(organization, project, environment),
        dataAction: "alerts",
      },
      ...(isManagedCloud
        ? [
            {
              id: "concurrency",
              name: "Concurrency",
              icon: ConcurrencyIcon,
              activeIconColor: "text-text-bright",
              to: concurrencyPath(organization, project, environment),
              dataAction: "concurrency",
            } satisfies SideMenuItemConfig,
          ]
        : []),
      {
        id: "limits",
        name: "Limits",
        icon: DialIcon,
        activeIconColor: "text-text-bright",
        to: limitsPath(organization, project, environment),
        dataAction: "limits",
      },
      {
        id: "integrations",
        name: "Integrations",
        icon: IntegrationsIcon,
        activeIconColor: "text-text-bright",
        to: v3ProjectSettingsIntegrationsPath(organization, project, environment),
        dataAction: "project-settings-integrations",
      },
    ],
  });

  return staticSections;
}
