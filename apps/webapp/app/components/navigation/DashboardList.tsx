import { IconChartHistogram } from "@tabler/icons-react";
import { GripVerticalIcon } from "lucide-react";
import ReactGridLayout from "react-grid-layout";
import { AIMetricsIcon } from "~/assets/icons/AIMetricsIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { type MatchedOrganization, useCustomDashboards } from "~/hooks/useOrganizations";
import { type UserWithDashboardPreferences } from "~/models/user.server";
import { type RenderIcon } from "~/components/primitives/Icon";
import { v3BuiltInDashboardPath, v3CustomDashboardPath } from "~/utils/pathBuilder";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";
import { SideMenuItem } from "./SideMenuItem";
import { TreeConnectorBranch, TreeConnectorEnd } from "./TreeConnectors";
import { useReorderableList } from "./useReorderableList";

type SideMenuUser = Pick<UserWithDashboardPreferences, "dashboardPreferences"> & {
  isImpersonating: boolean;
};

/**
 * Unified item for the reorderable dashboards-section list. Combines the two
 * built-in dashboards (Runs, Agents) and any user-created custom dashboards so
 * they can be reordered together under the Dashboards parent.
 */
type DashboardChild =
  | {
      key: string;
      kind: "builtin";
      label: string;
      path: string;
      collapsedIcon: RenderIcon;
      activeColor: string;
    }
  | {
      key: string;
      kind: "custom";
      label: string;
      path: string;
    };

export function DashboardList({
  organization,
  project,
  environment,
  isCollapsed,
  user,
}: {
  organization: MatchedOrganization;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  isCollapsed: boolean;
  user: SideMenuUser;
}) {
  const customDashboards = useCustomDashboards();

  const items: DashboardChild[] = [
    {
      key: "builtin:overview",
      kind: "builtin",
      label: "Run metrics",
      path: v3BuiltInDashboardPath(organization, project, environment, "overview"),
      collapsedIcon: RunsIcon,
      activeColor: "text-runs",
    },
    {
      key: "builtin:llm",
      kind: "builtin",
      label: "AI metrics",
      path: v3BuiltInDashboardPath(organization, project, environment, "llm"),
      collapsedIcon: AIMetricsIcon,
      activeColor: "text-aiMetrics",
    },
    ...customDashboards.map(
      (d): DashboardChild => ({
        key: `custom:${d.friendlyId}`,
        kind: "custom",
        label: d.title,
        path: v3CustomDashboardPath(organization, project, environment, d),
      })
    ),
  ];

  const initialOrder =
    user.dashboardPreferences.sideMenu?.organizations?.[organization.id]?.orderedItems?.[
      "dashboardChildren"
    ];

  const {
    orderedItems,
    layout,
    containerRef,
    gridWidth,
    canReorder,
    handleDrag,
    handleDragStop,
    getIsLast,
  } = useReorderableList({
    organizationId: organization.id,
    listId: "dashboardChildren",
    items,
    itemKey: (item) => item.key,
    initialOrder,
    isImpersonating: user.isImpersonating,
  });

  return (
    <div ref={containerRef}>
      {canReorder ? (
        <ReactGridLayout
          layout={layout}
          width={gridWidth}
          gridConfig={{
            cols: 1,
            rowHeight: 32,
            margin: [0, 0] as const,
            containerPadding: [0, 0] as const,
          }}
          resizeConfig={{ enabled: false }}
          dragConfig={{ enabled: !isCollapsed, handle: ".sidebar-drag-handle" }}
          onDrag={handleDrag}
          onDragStop={handleDragStop}
          className="sidebar-reorder-grid"
          autoSize
        >
          {orderedItems.map((item, index) => {
            const isLast = getIsLast(item.key, index);
            return (
              <div key={item.key}>
                <DashboardChildMenuItem
                  item={item}
                  isCollapsed={isCollapsed}
                  isLast={isLast}
                  showDragHandle
                />
              </div>
            );
          })}
        </ReactGridLayout>
      ) : (
        orderedItems.map((item, index) => (
          <DashboardChildMenuItem
            key={item.key}
            item={item}
            isCollapsed={isCollapsed}
            isLast={index === orderedItems.length - 1}
          />
        ))
      )}
    </div>
  );
}

function DashboardChildMenuItem({
  item,
  isCollapsed,
  isLast,
  showDragHandle = false,
}: {
  item: DashboardChild;
  isCollapsed: boolean;
  isLast: boolean;
  showDragHandle?: boolean;
}) {
  const collapsedIcon: RenderIcon =
    item.kind === "builtin" ? item.collapsedIcon : IconChartHistogram;
  const expandedIcon: RenderIcon = isLast ? TreeConnectorEnd : TreeConnectorBranch;

  const activeIconColor =
    item.kind === "builtin"
      ? isCollapsed
        ? item.activeColor
        : undefined
      : isCollapsed
      ? "text-text-bright"
      : undefined;

  const inactiveIconColor = isCollapsed ? "text-text-dimmed" : "text-charcoal-700";

  return (
    <SideMenuItem
      name={item.label}
      icon={isCollapsed ? collapsedIcon : expandedIcon}
      activeIconColor={activeIconColor}
      inactiveIconColor={inactiveIconColor}
      to={item.path}
      isCollapsed={isCollapsed}
      disableIconHover
      action={
        showDragHandle ? (
          <div className="sidebar-drag-handle flex h-full w-full cursor-grab items-center justify-center rounded text-text-dimmed opacity-0 group-hover/menuitem:opacity-100 hover:text-text-bright active:cursor-grabbing">
            <GripVerticalIcon className="size-3.5" />
          </div>
        ) : undefined
      }
    />
  );
}
