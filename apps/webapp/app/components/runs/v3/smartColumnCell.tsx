import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { Badge } from "~/components/primitives/Badge";
import { MiddleTruncate } from "~/components/primitives/MiddleTruncate";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import type { SmartColumnDef } from "./runColumns";
import type { SmartCellValue } from "./smartColumnData";

/** Number and duration columns right-align and use tabular figures. */
export function isNumericSmartDisplay(display: SmartColumnDef["displayAs"]): boolean {
  return display === "number" || display === "duration";
}

function stringifySmartValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Coerce to a finite number only from an actual number or a non-empty numeric
 * string. Returns NaN for null/boolean/empty-string/array/object so those fall
 * back to their raw rendering instead of coercing to a misleading 0.
 */
function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) return Number(value);
  return NaN;
}

/** How wide a truncated text cell may get before the middle is elided. */
const TEXT_CELL_MAX_WIDTH = "max-w-[600px]";
/** Long values are common enough that an instant tooltip would fire while just scanning rows. */
const TEXT_CELL_TOOLTIP_DELAY_MS = 500;
/** A whole payload string can be arbitrarily long, so the tooltip is capped and scrolls. */
const TEXT_CELL_TOOLTIP_CLASS =
  "block max-w-sm max-h-64 overflow-y-auto whitespace-pre-wrap scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control";

function renderSmartValue(
  value: unknown,
  displayAs: SmartColumnDef["displayAs"],
  truncate: boolean
): React.ReactNode {
  switch (displayAs) {
    case "number": {
      const n = toFiniteNumber(value);
      return Number.isFinite(n) ? n.toLocaleString() : stringifySmartValue(value);
    }
    case "duration": {
      const n = toFiniteNumber(value);
      return Number.isFinite(n)
        ? formatDurationMilliseconds(n, { style: "short" })
        : stringifySmartValue(value);
    }
    case "badge":
      return <Badge variant="extra-small">{stringifySmartValue(value)}</Badge>;
    default: {
      const text = stringifySmartValue(value);
      if (!truncate) return text;
      // MiddleTruncate measures against its parent, so it needs the width cap around it.
      return (
        <span className={cn("block min-w-0", TEXT_CELL_MAX_WIDTH)}>
          <MiddleTruncate
            text={text}
            tooltipDelay={TEXT_CELL_TOOLTIP_DELAY_MS}
            tooltipContentClassName={TEXT_CELL_TOOLTIP_CLASS}
          />
        </span>
      );
    }
  }
}

/**
 * The inner content of a smart-column cell (no table/row wrapper), shared by the
 * runs table and the add-column preview so both look identical. `offloaded`
 * shows a "Too large" tooltip, an absent path shows "–", and an in-flight run's
 * value is dotted-underlined to mark it provisional.
 */
export function SmartCellContent({
  cell,
  def,
  provisional,
  truncate = false,
}: {
  cell: SmartCellValue;
  def: SmartColumnDef;
  provisional: boolean;
  /** Middle-truncate long text to a fixed cap. On for the table; the preview scrolls instead. */
  truncate?: boolean;
}) {
  if (cell.state === "offloaded") {
    return (
      <SimpleTooltip
        disableHoverableContent
        button={
          <span className="border-b border-dotted border-amber-500/60 text-amber-500">
            Too large
          </span>
        }
        content={`This run's ${def.source} is offloaded to object storage instead of the run row. Open the run to read it.`}
      />
    );
  }

  if (cell.state === "empty") {
    return <span className="text-text-dimmed">–</span>;
  }

  return (
    <span className={cn(provisional && "border-b border-dotted border-text-dimmed/50")}>
      {renderSmartValue(cell.value, def.displayAs, truncate)}
    </span>
  );
}
