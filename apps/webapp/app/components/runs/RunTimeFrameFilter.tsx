import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { Button } from "../primitives/Buttons";
import { ChevronDownIcon } from "lucide-react";
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
          {timeFrameValues.map((timeframe) => (
            <Button
              key={timeframe.value}
              variant="tertiary/small"
              className={cn(
                "w-full border border-slate-700 group-hover:bg-slate-700",
                from &&
                  to &&
                  timeframe.value === to - from &&
                  "border-slate-700 bg-slate-700 group-hover:border-slate-700 group-hover:bg-slate-700"
              )}
              onClick={() => {
                setIsOpen(false);
                onValueChange(timeframe.value);
              }}
            >
              <Paragraph variant="extra-small">{timeframe.label}</Paragraph>
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const determineTimeFrame = (from: number | undefined, to: number | undefined) => {
  if (!from || !to) {
    return "Timeframe";
  }

  const timeframe = timeFrameValues.find((timeframe) => timeframe.value === to - from);

  if (!timeframe) {
    return `${new Date(from).toUTCString()} - ${new Date(to).toUTCString()}`;
  }

  return timeframe.label;
};

const timeFrameValues = [
  {
    label: "5 mins",
    value: 5 * 60 * 1000,
  },
  {
    label: "15 mins",
    value: 15 * 60 * 1000,
  },
  {
    label: "30 mins",
    value: 30 * 60 * 1000,
  },
  {
    label: "1 hour",
    value: 60 * 60 * 1000,
  },
  {
    label: "3 hours",
    value: 3 * 60 * 60 * 1000,
  },
  {
    label: "6 hours",
    value: 6 * 60 * 60 * 1000,
  },
  {
    label: "1 day",
    value: 24 * 60 * 60 * 1000,
  },
  {
    label: "3 days",
    value: 3 * 24 * 60 * 60 * 1000,
  },
  {
    label: "7 days",
    value: 7 * 24 * 60 * 60 * 1000,
  },
  {
    label: "10 days",
    value: 10 * 24 * 60 * 60 * 1000,
  },
  {
    label: "14 days",
    value: 14 * 24 * 60 * 60 * 1000,
  },
  {
    label: "30 days",
    value: 30 * 24 * 60 * 60 * 1000,
  },
];

export type RelativeTimeFrameItem = (typeof timeFrameValues)[number];
