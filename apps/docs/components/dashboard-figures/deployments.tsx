// The Deploys page: a list of deployments in one environment, the current one badged Current.
// The row menu variant adds a newer deployment that wasn't promoted and opens its menu. Drawn
// from source (the test dashboard had no deployments); the webapp files it mirrors are its
// `sources` in lib/dashboard-figures.ts.
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Env } from "./chrome";
import {
  AppFrame,
  Button,
  Cell,
  GitLinks,
  PageHeader,
  RowMenuItem,
  RowMenuPopover,
  SearchField,
  SideMenu,
  SmallSwitch,
  tableHeader,
  tableRow,
  td,
  th,
} from "./chrome";
import * as I from "./icons";

type Deployment = {
  shortCode: string;
  version: string;
  current?: boolean;
  tasks: number;
  deployedAt: string;
  by: string;
  commit: string;
};

const promoted: Deployment[] = [
  {
    shortCode: "3hd8w1pa",
    version: "20261125.1",
    current: true,
    tasks: 4,
    deployedAt: "25 Nov 2026, 9:58:04 am",
    by: "Sam Lee",
    commit: "4f9c2e1 / Add agent tools",
  },
  {
    shortCode: "9xv4n2ke",
    version: "20261124.1",
    tasks: 3,
    deployedAt: "24 Nov 2026, 4:47:31 pm",
    by: "Sam Lee",
    commit: "b7d03a8 / Back off retries",
  },
];

// Deployed with --skip-promotion: built and deployed, but not current.
const unpromoted: Deployment = {
  shortCode: "7kq2m9xz",
  version: "20261125.2",
  tasks: 4,
  deployedAt: "25 Nov 2026, 11:20:47 am",
  by: "Sam Lee",
  commit: "c1e5a90 / Add summary task",
};

function DeploymentRow({
  d,
  menu,
  marked,
}: {
  d: Deployment;
  /** Mark this row's menu button "actions" (one row only). */
  marked?: boolean;
  /** The row menu's items, open below the trigger. */
  menu?: ReactNode;
}) {
  return (
    <div className={tableRow}>
      <Cell>
        <div className="flex items-center gap-2">
          <span className="font-sans text-xs font-medium text-text-dimmed">{d.shortCode}</span>
          {d.current && (
            <div
              data-mark="current"
              className="grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright text-blue-500 whitespace-nowrap"
            >
              Current
            </div>
          )}
        </div>
      </Cell>
      <Cell>{d.version}</Cell>
      <Cell>
        <span className="flex items-center gap-1">
          <I.CheckCircleIcon className="text-success h-4 w-4" />
          <span className="system-mono-label text-success">Deployed</span>
        </span>
      </Cell>
      <Cell>
        <span className="flex items-center gap-1">
          <I.NodejsLogoIcon className="h-4 w-4" />
          <span>Node.js v22.21.1</span>
        </span>
      </Cell>
      <Cell>{d.tasks}</Cell>
      <Cell>{d.deployedAt}</Cell>
      <Cell>
        <div className="flex items-center gap-1">
          <I.AccountIcon className="aspect-square text-text-dimmed h-4 w-4" />
          <span className="font-sans text-xs font-medium text-text-dimmed">{d.by}</span>
        </div>
      </Cell>
      <Cell>–</Cell>
      <div className={`${td} px-3 py-3`}>
        <GitLinks branch="main" commit={d.commit} />
      </div>
      {/* TableCellMenu, sticky to the right edge. z-10 on the open row: the popover renders in
          a portal in the dashboard, so the rows below must not paint over it here. */}
      <div className={`${td} text-right sticky right-0 bg-background-dimmed ${menu ? "z-10" : ""}`}>
        <div className="relative h-full p-1">
          <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
            <div className="relative">
              <div
                data-mark={marked ? "actions" : undefined}
                data-mark-badge={marked ? "left" : undefined}
                className="group flex items-center justify-center size-6 rounded-[3px] text-text-dimmed"
              >
                <I.EllipsisVerticalIcon className="size-5" />
              </div>
              {menu && (
                // PopoverContent: align="end", 4px below the trigger.
                <div className="absolute right-0 top-full mt-1 text-left">
                  <RowMenuPopover bare>{menu}</RowMenuPopover>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Deployments({
  env,
  deployments,
  menuOpen,
}: {
  env: Env;
  deployments: Deployment[];
  menuOpen?: boolean;
}) {
  // Which menu items a row gets (DeploymentActionsCell): Promote for a deployment newer than the
  // current one, Rollback for an older one, and Redeploy for any finished deployment.
  const items = (d: Deployment, i: number) => {
    const currentIndex = deployments.findIndex((x) => x.current);
    return (
      <>
        {!d.current && i > currentIndex && (
          <RowMenuItem icon={I.ArrowUturnLeftIcon} iconClassName="text-blue-500">
            Rollback
          </RowMenuItem>
        )}
        {!d.current && i < currentIndex && (
          <RowMenuItem
            icon={I.PromoteIcon}
            iconClassName="text-blue-500"
            mark="promote"
            markBadge="left"
          >
            Promote
          </RowMenuItem>
        )}
        <RowMenuItem icon={I.ArrowPathIcon} iconClassName="text-blue-500">
          Redeploy
        </RowMenuItem>
      </>
    );
  };

  return (
    <AppFrame menu={<SideMenu active="Deploys" open={["Deployments"]} env={env} />}>
      <div className="grid h-full grid-rows-[auto_1fr]">
        <PageHeader title="Deployments">
          <Button variant="docs" icon={I.BookIcon}>
            Deployments docs
          </Button>
        </PageHeader>
        <div className="flex h-full max-h-full min-h-0 min-w-0 flex-col">
          <div className="flex items-center justify-between gap-x-2 p-2">
            <div className="flex flex-row flex-wrap items-center gap-1.5">
              <SearchField placeholder="Search version…" />
              <div className="flex h-6 items-center gap-1.5 rounded border border-border-bright bg-secondary pl-1 pr-2 text-xs text-text-bright">
                <I.StatusIcon className="size-3.5" />
                <span>Status</span>
              </div>
              <div className="flex h-6 items-center gap-1.5 rounded border border-border-bright bg-secondary pl-1 pr-2 text-xs text-text-bright">
                <GitBranchIcon className="size-3.5" />
                <span>Branch</span>
              </div>
              <SmallSwitch
                label={
                  <span className="flex items-center gap-1">
                    <I.Squares2X2Icon className="size-3.5 text-text-dimmed" />
                    Activity
                  </span>
                }
              />
            </div>
          </div>
          {/* Table: overflow-x-auto in the dashboard; the columns past the edge are cut off. */}
          <div className="grow overflow-hidden whitespace-nowrap border-t">
            <div className="table w-full">
              <div className={tableHeader}>
                <div className={tableRow}>
                  <div className={th}>Deploy</div>
                  <div className={th}>Version</div>
                  <div className={th}>
                    <div className="flex items-center gap-1">
                      Status
                      <I.InformationCircleIcon className="size-3.5 text-text-dimmed" />
                    </div>
                  </div>
                  <div className={th}>Runtime</div>
                  <div className={th}>Tasks</div>
                  <div className={th}>Deployed at</div>
                  <div className={th}>Deployed by</div>
                  <div className={th}>External ID</div>
                  <div className={th}>Git</div>
                  <div className={th} />
                </div>
              </div>
              <div className="table-row-group relative">
                {deployments.map((d, i) => (
                  <DeploymentRow
                    key={d.shortCode}
                    d={d}
                    marked={i === 0 && !d.current}
                    menu={menuOpen && i === 0 ? items(d, i) : undefined}
                  />
                ))}
              </div>
            </div>
          </div>
          {/* The footer bar: pagination (none for a single page) and, with a connected repo,
              the GitHub branch it deploys from. */}
          <div className="-mt-px flex flex-wrap justify-end gap-2 border-t border-grid-dimmed px-3 pb-[7px] pt-[6px]">
            <div className="h-6" />
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

export function DeploymentsFigure() {
  return <Deployments env="prod" deployments={promoted} />;
}

export function DeploymentsNotPromotedFigure() {
  return <Deployments env="prod" deployments={[unpromoted, ...promoted]} />;
}

export function DeploymentsRowMenuFigure() {
  return <Deployments env="prod" deployments={[unpromoted, ...promoted]} menuOpen />;
}

export function DeploymentsStagingFigure() {
  return <Deployments env="staging" deployments={[{ ...promoted[0], shortCode: "5mt0c7rb" }]} />;
}
