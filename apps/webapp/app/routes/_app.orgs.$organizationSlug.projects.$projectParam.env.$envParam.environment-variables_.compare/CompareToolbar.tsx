import { type ReactNode } from "react";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { cn } from "~/utils/cn";

export type CompareKindOption = {
  value: string;
  /** Short, shown in the control: "Missing" with an environment icon, "Empty". */
  label: ReactNode;
  /** The full wording, for the tooltip and the accessible name. Undefined when the label says it. */
  title?: string;
  /** Undefined when nothing was compared (too many keys): no number is shown. */
  count?: number;
};

export type CompareToolbarProps = {
  search: ReactNode;
  kinds: CompareKindOption[];
  selectedKind: string;
  onKindChange: (value: string) => void;
  /** The applied-filter chip for a subset of keys, when there is one. */
  subset: ReactNode;
  revealSwitch: ReactNode;
};

function KindLabel({ option, isSelected }: { option: CompareKindOption; isSelected: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap",
        // A kind with nothing in it stays pickable, but steps back.
        (option.count === undefined || option.count === 0) && !isSelected && "opacity-50"
      )}
    >
      {option.title && <span className="sr-only">{option.title}</span>}
      <span className="flex items-center gap-1" aria-hidden={option.title ? true : undefined}>
        {option.label}
      </span>
      {option.count !== undefined && (
        <span className="tabular-nums text-text-dimmed">{option.count}</span>
      )}
    </span>
  );
}

function KindSegments({ kinds, selectedKind, onKindChange }: CompareToolbarProps) {
  return (
    <SegmentedControl
      name="kind"
      variant="secondary/small"
      value={selectedKind}
      options={kinds.map((option) => ({
        value: option.value,
        label: <KindLabel option={option} isSelected={option.value === selectedKind} />,
        tooltip: option.title,
      }))}
      onChange={onKindChange}
    />
  );
}

/** One row like the list's toolbar. The side pickers are the table's column headers. */
export function CompareToolbar(props: CompareToolbarProps) {
  return (
    // Wide: one row, the switches holding the right end; a long branch name wraps the kinds under
    // the search. Narrow (the key panel open): the kinds take the second row on their own, so the
    // search, chip and switches share the first and it never needs a third.
    <div className="@container px-2 py-2">
      <div className="flex flex-wrap items-start gap-1.5">
        <div className="flex min-w-min flex-1 flex-wrap items-center gap-1.5 *:shrink-0 @max-[64rem]:contents">
          {props.search}
          {props.subset}
          <div className="@max-[64rem]:order-last @max-[64rem]:basis-full">
            <KindSegments {...props} />
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-0.5">
          {props.revealSwitch}
        </div>
      </div>
    </div>
  );
}
