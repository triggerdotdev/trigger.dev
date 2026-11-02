import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import {
  addGrouping,
  dropGrouping,
  moveGrouping,
  removeGrouping,
  type UsageDimension,
} from "~/utils/billingUsageBreakdown";
import { usageDimensionTitle } from "~/utils/billingUsageFormat";
import { cn } from "~/utils/cn";

export function GroupingChips({
  groupings,
  available,
  onChange,
}: {
  groupings: UsageDimension[];
  available: UsageDimension[];
  onChange: (groupings: UsageDimension[]) => void;
}) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [dragging, setDragging] = useState<UsageDimension | null>(null);
  const unused = available.filter((dimension) => !groupings.includes(dimension));

  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Group by" role="group">
      <span className="mr-1 text-xs text-text-dimmed">Group by</span>
      {groupings.map((dimension, index) => (
        <div key={dimension} className="flex items-center gap-1">
          {index > 0 && <span className="text-xs text-text-dimmed">›</span>}
          <div
            draggable
            onDragStart={() => setDragging(dimension)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => dragging && dragging !== dimension && event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging) onChange(dropGrouping(groupings, dragging, dimension));
            }}
            className={cn(
              "flex h-6 cursor-grab items-center gap-0.5 rounded border border-grid-bright bg-background-raised pl-2 pr-0.5 text-xs text-text-bright active:cursor-grabbing",
              dragging === dimension && "opacity-50"
            )}
          >
            <span className="mr-0.5 tabular-nums text-text-dimmed">{index + 1}</span>
            <span className="mr-1">{usageDimensionTitle(dimension)}</span>
            <ChipButton
              label={`Move ${usageDimensionTitle(dimension)} earlier`}
              icon={ChevronLeftIcon}
              disabled={index === 0}
              onClick={() => onChange(moveGrouping(groupings, dimension, -1))}
            />
            <ChipButton
              label={`Move ${usageDimensionTitle(dimension)} later`}
              icon={ChevronRightIcon}
              disabled={index === groupings.length - 1}
              onClick={() => onChange(moveGrouping(groupings, dimension, 1))}
            />
            <ChipButton
              label={`Remove ${usageDimensionTitle(dimension)}`}
              icon={XMarkIcon}
              disabled={groupings.length === 1}
              onClick={() => onChange(removeGrouping(groupings, dimension))}
            />
          </div>
        </div>
      ))}
      {unused.length > 0 && (
        <Popover open={isAddOpen} onOpenChange={setIsAddOpen}>
          <PopoverTrigger asChild>
            <Button variant="minimal/small" LeadingIcon={PlusIcon}>
              Add
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="min-w-40 p-1">
            {unused.map((dimension) => (
              <PopoverMenuItem
                key={dimension}
                title={usageDimensionTitle(dimension)}
                onClick={() => {
                  setIsAddOpen(false);
                  onChange(addGrouping(groupings, dimension));
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function ChipButton({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof XMarkIcon;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded-sm text-text-dimmed transition hover:bg-background-hover hover:text-text-bright disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="size-3.5" />
    </button>
  );
}
