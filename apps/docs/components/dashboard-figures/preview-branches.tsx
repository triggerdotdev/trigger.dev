// The Preview branches page in Development, with three branches and auto-archive off; the row
// menu variant opens the first branch's menu. Drawn from source (the test dashboard had no
// branches); the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import {
  AppFrame,
  Button,
  GitLinks,
  PageHeader,
  RowMenuItem,
  RowMenuPopover,
  SearchField,
  SideMenu,
  SmallSwitch,
  tableHeader,
  tableRow,
  th,
} from "./chrome";
import * as I from "./icons";

type Branch = {
  name: string;
  created: string;
  lastDeployment: string;
  commit?: string;
};

const branches: Branch[] = [
  {
    name: "feature/agents",
    created: "24 Nov 2026, 3:12:40 pm",
    lastDeployment: "25 Nov 2026, 9:58:04 am",
    commit: "4f9c2e1 / Add agent tools",
  },
  {
    name: "fix/retry-backoff",
    created: "21 Nov 2026, 11:05:12 am",
    lastDeployment: "24 Nov 2026, 4:47:31 pm",
    commit: "b7d03a8 / Back off retries",
  },
  // Made with New branch in the dashboard: no deployments and no git metadata yet.
  { name: "docs/onboarding", created: "18 Nov 2026, 9:20:55 am", lastDeployment: "Never" },
];

const USED = 3;
const LIMIT = 10;

// Table.tsx, "dimmed" variant. align-middle: a real <td> is vertically centered by default.
const td = "table-cell align-middle text-xs text-text-dimmed px-3 py-3 text-left";

function BranchRow({ branch, open }: { branch: Branch; open: boolean }) {
  return (
    <div className={tableRow}>
      <div className={td}>
        <div className="flex items-center gap-1">
          <I.PreviewBranchesIcon className="size-4" />
          <span className="group relative inline-flex h-6 items-center">
            <span>{branch.name}</span>
          </span>
        </div>
      </div>
      <div className={td}>{branch.created}</div>
      <div className={td}>{branch.lastDeployment}</div>
      <div className={td}>Disabled</div>
      <div className={td}>
        <div className="-ml-1 flex items-center">
          <GitLinks branch={branch.commit && branch.name} commit={branch.commit} />
        </div>
      </div>
      <div className={td}>–</div>
      {/* TableCellMenu, sticky to the right edge. The Switch to branch button beside the menu
          only shows on hover. z-10 on the open row: the popover renders in a portal in the
          dashboard, so the rows below must not paint over it here. */}
      <div
        className={`table-cell align-middle text-xs text-text-dimmed text-right pl-32 sticky right-0 bg-background-dimmed ${open ? "z-10" : ""}`}
      >
        <div className="relative h-full p-1">
          <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
            <div className="relative">
              <div
                data-mark={open ? "actions" : undefined}
                data-mark-badge={open ? "left" : undefined}
                className="group flex items-center justify-center size-6 rounded-[3px] text-text-dimmed"
              >
                <I.EllipsisVerticalIcon className="size-5" />
              </div>
              {open && (
                // PopoverContent: align="end", 4px below the trigger.
                <div className="absolute right-0 top-full mt-1 text-left">
                  <RowMenuPopover>
                    <RowMenuItem
                      icon={I.ArrowBearRightIcon}
                      iconClassName="text-blue-500 -mr-0.5 -ml-1"
                    >
                      Switch to branch
                    </RowMenuItem>
                    <RowMenuItem
                      icon={I.ArchiveIcon}
                      iconClassName="text-error"
                      mark="archive"
                      markBadge="left"
                    >
                      Archive branch
                    </RowMenuItem>
                  </RowMenuPopover>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewBranches({ menuOpen }: { menuOpen: boolean }) {
  return (
    <AppFrame menu={<SideMenu active="Preview branches" open={["Deployments"]} />}>
      <div className="grid h-full grid-rows-[auto_1fr]">
        <PageHeader title="Preview branches">
          <Button variant="docs" icon={I.BookIcon}>
            Branches docs
          </Button>
        </PageHeader>
        <div className="grid min-h-0 grid-rows-[auto_1fr_auto]">
          <div className="flex items-center justify-between gap-x-1.5 p-2">
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <SearchField placeholder="Search branch name…" />
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <SmallSwitch label="Show archived" />
                <SmallSwitch label="Auto-archive" />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="primary"
                icon={I.PlusIcon}
                iconClassName="text-white"
                shortcut="n"
                mark="new-branch"
                markBadge="below"
              >
                New branch…
              </Button>
            </div>
          </div>
          <div className="min-h-0 whitespace-nowrap border-t">
            <div className="table w-full">
              <div className={tableHeader}>
                <div className={tableRow}>
                  <div className={th}>Branch</div>
                  <div className={th}>Created</div>
                  <div className={th}>Last deployment</div>
                  <div className={th}>Auto-archive</div>
                  <div className={th}>Git</div>
                  <div className={th}>Archived</div>
                  <div className={th} />
                </div>
              </div>
              <div className="table-row-group relative">
                {branches.map((branch, i) => (
                  <BranchRow key={branch.name} branch={branch} open={menuOpen && i === 0} />
                ))}
              </div>
            </div>
          </div>
          {/* The usage bar: a ring filled to the share of branches used. */}
          <div className="flex w-full items-start justify-between">
            <div className="flex h-fit w-full items-center gap-4 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
              <div className="size-6">
                <svg className="h-full w-full -rotate-90 overflow-visible">
                  <circle
                    className="fill-none stroke-grid-bright"
                    strokeWidth="4"
                    r="10"
                    cx="12"
                    cy="12"
                  />
                  <circle
                    className="fill-none stroke-success"
                    strokeWidth="4"
                    r="10"
                    cx="12"
                    cy="12"
                    strokeDasharray={`${(USED / LIMIT) * 62.8} 62.8`}
                    strokeDashoffset="0"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="flex w-full items-center justify-between gap-6">
                <div className="flex items-center gap-1">
                  <div className="font-sans text-sm leading-5 font-semibold text-text-bright">
                    You've used {USED}/{LIMIT} of your branches
                  </div>
                  <span className="h-fit">
                    <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

export function PreviewBranchesFigure() {
  return <PreviewBranches menuOpen={false} />;
}

export function PreviewBranchesRowMenuFigure() {
  return <PreviewBranches menuOpen />;
}
