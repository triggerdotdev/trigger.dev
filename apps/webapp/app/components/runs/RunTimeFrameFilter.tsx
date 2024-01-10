import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { Button } from "../primitives/Buttons";
import { ChevronDownIcon } from "lucide-react";
import { FilterableRelativeTimeFrame, relativeTimeFrameKeys } from "./RunStatuses";
import { Paragraph } from "../primitives/Paragraph";
import { cn } from "~/utils/cn";

type RunTimeFrameFilterProps = {
  from?: number;
  to?: number;
  onValueChange: (value: number) => void;
};

export function RunTimeFrameFilter({ from, to, onValueChange }: RunTimeFrameFilterProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover onOpenChange={(open) => setIsOpen(open)} open={isOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="secondary/small"
          className="bg-slate-800 group-hover:bg-tertiary-foreground"
        >
          <Paragraph variant="extra-small" className="mr-2">
            {determineTimeFrame(from, to)}
          </Paragraph>

          <ChevronDownIcon className="h-4 w-4 text-bright" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="border border-slate-800 bg-popover">
        <Paragraph variant="extra-small" className="mb-4 uppercase">
          TimeFrame
        </Paragraph>

        <div className="grid grid-cols-3 gap-2">
          {relativeTimeFrameKeys.map((timeframe) => (
            <Button
              key={timeframe}
              variant="tertiary/small"
              className={cn(
                "w-full border border-slate-700 group-hover:bg-slate-700",
                from &&
                  to &&
                  filterRelativeTimeFrameValue(timeframe) === to - from &&
                  "border-slate-700 bg-slate-700 group-hover:border-slate-700 group-hover:bg-slate-700"
              )}
              onClick={() => {
                setIsOpen(false);
                onValueChange(filterRelativeTimeFrameValue(timeframe));
              }}
            >
              <Paragraph variant="extra-small">{timeframe}</Paragraph>
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const determineTimeFrame = (from: number | undefined, to: number | undefined) => {
  if (!from || !to) {
    return "Timeframe";
  }

  const timeframe = relativeTimeFrameKeys.find(
    (timeframe) => filterRelativeTimeFrameValue(timeframe) === to - from
  );

  if (!timeframe) {
    return `${new Date(from).toUTCString()} - ${new Date(to).toUTCString()}`;
  }

  return timeframe;
};

export function filterRelativeTimeFrameValue(timeframe: FilterableRelativeTimeFrame) {
  switch (timeframe) {
    case "5 mins":
      return 5 * 60 * 1000;
    case "15 mins":
      return 15 * 60 * 1000;
    case "30 mins":
      return 30 * 60 * 1000;
    case "1 hour":
      return 60 * 60 * 1000;
    case "3 hours":
      return 3 * 60 * 60 * 1000;
    case "6 hours":
      return 6 * 60 * 60 * 1000;
    case "1 day":
      return 24 * 60 * 60 * 1000;
    case "3 days":
      return 3 * 24 * 60 * 60 * 1000;
    case "7 days":
      return 7 * 24 * 60 * 60 * 1000;
    case "10 days":
      return 10 * 24 * 60 * 60 * 1000;
    case "14 days":
      return 14 * 24 * 60 * 60 * 1000;
    case "30 days":
      return 30 * 24 * 60 * 60 * 1000;
    default:
      const _exhaustiveCheck: never = timeframe;
      throw new Error(`Non-exhaustive match for value: ${timeframe}`);
  }
}
