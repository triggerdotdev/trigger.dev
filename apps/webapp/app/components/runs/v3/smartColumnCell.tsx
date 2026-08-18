import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { Badge } from "~/components/primitives/Badge";
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

function renderSmartValue(value: unknown, displayAs: SmartColumnDef["displayAs"]): React.ReactNode {
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
    default:
      return stringifySmartValue(value);
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
}: {
  cell: SmartCellValue;
  def: SmartColumnDef;
  provisional: boolean;
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
      {renderSmartValue(cell.value, def.displayAs)}
    </span>
  );
}
