// The Runs page (runs-list.tsx) after More filters > Tags, with "org:acme" typed in the tags search.
// The tags dropdown (RunFilters.tsx TagsDropdown, Select.tsx SelectPopover) opens 5px under More
// filters (gutter 5), left-aligned. Example tags as in the dashboard's own reference capture.
import { RunsHeader, RunsTable, RunsToolbar } from "./runs-list";

const tags = ["org:acme_123", "org:acme_456", "org:acme_789", "org:acme_901"];

// SelectPopover with TagsDropdown's min-w-0 and max-w-[min(240px,...)]. Its width comes from the
// search input's intrinsic width (a native input, size 20): 181px in the dashboard capture.
const dropdown = (
  // The mark sits on a wrapper: the popover's overflow-clip would clip the badge.
  <div data-mark="tags" className="absolute left-0 top-full mt-[5px] z-50 rounded">
    <div className="flex flex-col overflow-clip rounded border border-grid-bright bg-background-bright shadow-md w-[181px]">
      {/* ComboBox; the input keeps @tailwindcss/forms' 0.75rem side padding. */}
      <div className="flex h-9 w-full flex-none items-center border-b border-grid-dimmed bg-transparent pl-0 pr-3 text-xs text-text-dimmed">
        <div className="flex flex-1 items-center justify-stretch">
          <span className="flex-1 px-3 text-xs text-text-dimmed">org:acme</span>
        </div>
      </div>
      <div className="overflow-y-auto overflow-x-hidden">
        {tags.map((tag, i) => (
          <div key={tag} className="group px-1 pt-1 text-2sm text-text-dimmed last:pb-1">
            {/* The first match is the active item (autoSelect). */}
            <div
              className={`flex w-full items-center rounded-sm px-2 h-8 gap-1 ${i === 0 ? "bg-tertiary" : ""}`}
            >
              <div className="grow truncate">{tag}</div>
              <span className="size-8 flex-none text-text-bright" />
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export function RunsListFilterTagsFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunsHeader />
      <RunsToolbar moreFilters={dropdown} />
      <RunsTable />
    </div>
  );
}
