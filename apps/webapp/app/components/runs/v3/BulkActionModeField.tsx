import type { ReactNode } from "react";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";

export type BulkActionModeValue = "filter" | "selected";

/**
 * Which runs a bulk action covers: every run matching the filters, or the selected ones.
 * Controlled: the runs list's shortcuts change the mode while the panel is open, and the form
 * must submit the mode the panel shows.
 */
export function BulkActionModeField({
  mode,
  onModeChange,
  filterLabel,
  selectedLabel,
}: {
  mode: BulkActionModeValue;
  onModeChange: (mode: string) => void;
  filterLabel: ReactNode;
  selectedLabel: ReactNode;
}) {
  return (
    <RadioGroup
      name="mode"
      className="flex flex-col items-start gap-2"
      value={mode}
      onValueChange={onModeChange}
    >
      <RadioGroupItem
        id="mode-filter"
        label={filterLabel}
        value={"filter"}
        variant="button/small"
      />
      <RadioGroupItem
        id="mode-selected"
        label={selectedLabel}
        value={"selected"}
        variant="button/small"
        className="grow tabular-nums"
      />
    </RadioGroup>
  );
}
