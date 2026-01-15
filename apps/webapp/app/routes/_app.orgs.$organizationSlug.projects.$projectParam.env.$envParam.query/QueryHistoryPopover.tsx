import { useState } from "react";
import { ClockRotateLeftIcon } from "~/assets/icons/ClockRotateLeftIcon";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import type { QueryHistoryItem } from "~/presenters/v3/QueryPresenter.server";

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
  // Normalize whitespace for display (let CSS line-clamp handle truncation)
  const normalized = query.replace(/\s+/g, " ").slice(0, 200);
  const suffix = "";

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

  if (suffix) {
    parts.push(suffix);
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
          variant="tertiary/small"
          LeadingIcon={ClockRotateLeftIcon}
          disabled={history.length === 0}
        >
          History
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[400px] min-w-0 overflow-hidden p-0"
        align="start"
        sideOffset={6}
      >
        <div className="max-h-80 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <div className="p-1">
            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onQuerySelected(item);
                  setIsOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 outline-none transition-colors focus-custom hover:bg-charcoal-900"
              >
                <div className="flex flex-1 flex-col items-start overflow-hidden">
                  <p className="line-clamp-2 w-full break-words text-left font-mono text-xs text-[#9b99ff]">
                    {highlightSQL(item.query)}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-text-dimmed">
                    <DateTime date={item.createdAt} showTooltip={false} />
                    {item.userName && <span>· {item.userName}</span>}
                    <span className="capitalize">· {item.scope}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

