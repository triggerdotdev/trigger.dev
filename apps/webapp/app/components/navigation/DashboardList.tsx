import { IconChartHistogram } from "@tabler/icons-react";
import { GripVerticalIcon, LineChartIcon } from "lucide-react";
import ReactGridLayout from "react-grid-layout";
import { type MatchedOrganization, useCustomDashboards } from "~/hooks/useOrganizations";
import { type UserWithDashboardPreferences } from "~/models/user.server";
import { v3CustomDashboardPath } from "~/utils/pathBuilder";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";
import { SideMenuItem } from "./SideMenuItem";
import { TreeConnectorBranch, TreeConnectorEnd } from "./TreeConnectors";
import { useReorderableList } from "./useReorderableList";

type SideMenuUser = Pick<UserWithDashboardPreferences, "dashboardPreferences"> & {
  isImpersonating: boolean;
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
  const initialOrder =
    user.dashboardPreferences.sideMenu?.organizations?.[organization.id]?.orderedItems?.[
      "customDashboards"
    ];

  const {
    orderedItems: orderedDashboards,
    layout,
    containerRef,
    gridWidth,
    canReorder,
    handleDrag,
    handleDragStop,
    getIsLast,
  } = useReorderableList({
    organizationId: organization.id,
    listId: "customDashboards",
    items: customDashboards,
    itemKey: (d) => d.friendlyId,
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
          {orderedDashboards.map((dashboard, index) => {
            const isLast = getIsLast(dashboard.friendlyId, index);
            return (
              <div key={dashboard.friendlyId}>
                <SideMenuItem
                  name={dashboard.title}
                  icon={
                    isCollapsed
                      ? IconChartHistogram
                      : isLast
                      ? TreeConnectorEnd
                      : TreeConnectorBranch
                  }
                  activeIconColor={isCollapsed ? "text-customDashboards" : undefined}
                  inactiveIconColor={isCollapsed ? "text-customDashboards" : undefined}
                  to={v3CustomDashboardPath(organization, project, environment, dashboard)}
                  isCollapsed={isCollapsed}
                  action={
                    <div className="sidebar-drag-handle flex h-full w-full cursor-grab items-center justify-center rounded text-text-dimmed opacity-0 transition group-hover/menuitem:opacity-100 hover:text-text-bright active:cursor-grabbing">
                      <GripVerticalIcon className="size-3.5" />
                    </div>
                  }
                />
              </div>
            );
          })}
        </ReactGridLayout>
      ) : (
        orderedDashboards.map((dashboard, index) => {
          const isLast = index === orderedDashboards.length - 1;
          return (
            <SideMenuItem
              key={dashboard.friendlyId}
              name={dashboard.title}
              icon={
                isCollapsed
                  ? LineChartIcon
                  : isLast
                  ? TreeConnectorEnd
                  : TreeConnectorBranch
              }
              activeIconColor={isCollapsed ? "text-customDashboards" : "text-charcoal-700"}
              inactiveIconColor={isCollapsed ? "text-customDashboards" : "text-charcoal-700"}
              to={v3CustomDashboardPath(organization, project, environment, dashboard)}
              isCollapsed={isCollapsed}
            />
          );
        })
      )}
    </div>
  );
}
