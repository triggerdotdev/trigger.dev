// The Tags column of the runs table, cropped: tags with a prefix show it apart from the value.
// Drawn from source; the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { tableHeader, tableRow, th } from "./chrome";
import * as I from "./icons";
import { RunTagView } from "./run-parts";

// Table.tsx, "dimmed" variant, as in runs-list.tsx.
const td = "table-cell align-middle text-xs text-text-dimmed pr-16";
const link =
  "flex w-full whitespace-nowrap items-center text-text-dimmed px-3 py-1 text-xs justify-start text-left";

const rows = [
  ["org:acme_123", "user:user_456"],
  ["org:acme_123", "user:user_789"],
];

export function RunsListTagsFigure() {
  return (
    <div className="h-full bg-background-dimmed">
      <div className="whitespace-nowrap overflow-hidden">
        <div className="table w-full">
          <div className={tableHeader}>
            <div className="table-row">
              <div className={th}>
                <div className="flex items-center gap-1">
                  Tags
                  <span className="h-fit">
                    <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="table-row-group relative">
            {rows.map((tags, i) => (
              <div key={i} className={tableRow}>
                <div className={td}>
                  <span className={link}>
                    <div className="flex gap-1">
                      {tags.map((tag) => (
                        <RunTagView key={tag} tag={tag} />
                      ))}
                    </div>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
