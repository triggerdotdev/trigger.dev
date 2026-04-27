import { useState } from "react";
import { ClockRotateLeftIcon } from "~/assets/icons/ClockRotateLeftIcon";
import { Button } from "~/components/primitives/Buttons";
import { Popover, PopoverTrigger } from "~/components/primitives/Popover";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { QueryHistoryItem } from "~/presenters/v3/QueryPresenter.server";
import { timeFilterRenderValues } from "~/components/runs/v3/SharedFilters";
import { ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "ORDER BY",
  "LIMIT",
  "GROUP BY",
  "HAVING",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "AND",
  "OR",
  "AS",
  "ON",
  "IN",
  "NOT",
  "NULL",
  "DESC",
  "ASC",
  "DISTINCT",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
];

function highlightSQL(query: string): React.ReactNode[] {
  // Normalize: collapse multiple spaces/tabs to single space, but preserve newlines
  // Then trim each line and limit total length
  const normalized = query
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 500);

  // Create a regex pattern that matches keywords as whole words (case insensitive)
  const keywordPattern = new RegExp(
    `\\b(${SQL_KEYWORDS.map((k) => k.replace(/\s+/g, "\\s+")).join("|")})\\b`,
    "gi"
  );

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = keywordPattern.exec(normalized)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(normalized.slice(lastIndex, match.index));
    }
    // Add the highlighted keyword
    parts.push(
      <span key={match.index} className="text-[#c678dd]">
        {match[0]}
      </span>
    );
    lastIndex = keywordPattern.lastIndex;
  }

  // Add remaining text
  if (lastIndex < normalized.length) {
    parts.push(normalized.slice(lastIndex));
  }

  return parts;
}

export function QueryHistoryPopover({
  history,
  onQuerySelected,
}: {
  history: QueryHistoryItem[];
  onQuerySelected: (item: QueryHistoryItem) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary/small"
          LeadingIcon={ClockRotateLeftIcon}
          leadingIconClassName="-mr-1.5"
          TrailingIcon={ChevronUpDownIcon}
          disabled={history.length === 0}
        >
          History
        </Button>
      </PopoverTrigger>
      <PopoverPrimitive.Content
        className={cn(
          "z-50 w-[400px] min-w-0 overflow-hidden rounded border border-charcoal-700 bg-background-bright p-0 shadow-md outline-none animate-in data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
        )}
        align="start"
        sideOffset={6}
        style={{ maxHeight: "var(--radix-popover-content-available-height)" }}
      >
        <div className="max-h-[40rem] overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <div className="p-1">
            {history.map((item) => {
              // Format time filter display
              const { valueLabel } = timeFilterRenderValues({
                period: item.filterPeriod ?? undefined,
                from: item.filterFrom ?? undefined,
                to: item.filterTo ?? undefined,
              });

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onQuerySelected(item);
                    setIsOpen(false);
                  }}
                  className="flex w-full flex-col gap-1 rounded-sm px-2 py-2 outline-none transition-colors focus-custom hover:bg-charcoal-750"
                >
                  <div className="flex w-full flex-col items-start">
                    {item.title ? (
                      <p className="mb-1 truncate text-left text-sm font-medium text-text-bright">
                        {item.title}
                      </p>
                    ) : (
                      <p className="mb-1 truncate text-left font-mono text-xs text-text-bright">
                        {item.query.split("\n")[0].slice(0, 60)}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 text-xs text-text-dimmed">
                      <span className="capitalize">{item.scope}</span>
                      {valueLabel && <span>· {valueLabel}</span>}
                      {item.userName && <span>· {item.userName}</span>}
                    </div>
                  </div>
                  <div className="w-full border-l-2 border-charcoal-600 pl-2.5">
                    <p className="line-clamp-4 w-full whitespace-pre-wrap text-left font-mono text-xs text-text-dimmed">
                      {highlightSQL(item.query)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverPrimitive.Content>
    </Popover>
  );
}
