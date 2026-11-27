// The Runs page (runs-list.tsx) with the Failed run's row menu open. The dashboard portals the
// popover; here it sits under its trigger, end-aligned, 4px below (align="end", sideOffset 4), and
// text-left undoes the cell's text-right it would otherwise inherit.
import { RowMenuItem } from "./chrome";
import * as I from "./icons";
import { RunsHeader, RunsTable, RunsToolbar } from "./runs-list";

const menu = (
  <div className="absolute right-0.5 top-full mt-0.5 z-50 rounded border border-grid-bright bg-background-bright shadow-md min-w-40 max-w-80 p-0 text-left">
    <div className="flex flex-col gap-1 p-1">
      <RowMenuItem
        markInner
        icon={I.ArrowRightIcon}
        iconClassName="text-blue-500"
        className="h-[1.8rem] px-[0.4rem] rounded-sm text-2sm"
      >
        View run
      </RowMenuItem>
      {/* DialogTrigger's classes merge in: h-6 and px-1.5 py-[0.9rem] (still 1.8rem tall). */}
      <RowMenuItem
        markInner
        icon={I.ArrowPathIcon}
        iconClassName="text-success"
        className="h-6 w-full rounded-sm px-1.5 py-[0.9rem] text-2sm"
        mark="replay"
      >
        Replay run…
      </RowMenuItem>
    </div>
  </div>
);

export function RunsListRowMenuFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunsHeader />
      <RunsToolbar />
      <RunsTable menu={menu} />
    </div>
  );
}
