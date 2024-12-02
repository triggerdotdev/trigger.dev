import { ChevronDownIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { ClientTabs, ClientTabsContent, ClientTabsWithUnderline } from "../primitives/ClientTabs";
import { DateField } from "../primitives/DateField";
import { formatDateTime } from "../primitives/DateTime";
import { Paragraph } from "../primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { Label } from "../primitives/Label";

type RunTimeFrameFilterProps = {
  from?: number;
  to?: number;
  onRangeChanged: (range: { from?: number; to?: number }) => void;
};

type Mode = "absolute" | "relative";

export function TimeFrameFilter({ from, to, onRangeChanged }: RunTimeFrameFilterProps) {
  const [activeTab, setActiveTab] = useState<Mode>("absolute");
  const [isOpen, setIsOpen] = useState(false);
  const [relativeTimeSeconds, setRelativeTimeSeconds] = useState<number | undefined>();

  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(to) : undefined;

  const relativeTimeFrameChanged = useCallback((value: number) => {
    const to = new Date().getTime();
    const from = to - value;
    onRangeChanged({ from, to });
    setRelativeTimeSeconds(value);
  }, []);

  const absoluteTimeFrameChanged = useCallback(({ from, to }: { from?: Date; to?: Date }) => {
    setRelativeTimeSeconds(undefined);
    const fromTime = from?.getTime();
    const toTime = to?.getTime();
    onRangeChanged({ from: fromTime, to: toTime });
  }, []);

  return (
    <Popover onOpenChange={(open) => setIsOpen(open)} open={isOpen} modal>
      <PopoverTrigger asChild>
        <Button variant="minimal/small">
          <Paragraph variant="extra-small" className="transition group-hover:text-text-bright">
            {title(from, to, relativeTimeSeconds)}
          </Paragraph>
          <ChevronDownIcon className="-ml-1.5 size-4 transition group-hover:text-text-bright" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="bg-background-dimmed p-2">
        <ClientTabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as Mode)}
          className="p-1"
        >
          <ClientTabsWithUnderline
            tabs={[
              { label: "Absolute", value: "absolute" },
              { label: "Relative", value: "relative" },
            ]}
            currentValue={activeTab}
            layoutId={"time-tabs"}
          />
          <ClientTabsContent value={"absolute"}>
            <AbsoluteTimeFrame
              from={fromDate}
              to={toDate}
              onValueChange={absoluteTimeFrameChanged}
            />
          </ClientTabsContent>
          <ClientTabsContent value={"relative"}>
            <RelativeTimeFrame
              value={relativeTimeSeconds}
              onValueChange={relativeTimeFrameChanged}
            />
          </ClientTabsContent>
        </ClientTabs>
      </PopoverContent>
    </Popover>
  );
}

function title(
  from: number | undefined,
  to: number | undefined,
  relativeTimeSeconds: number | undefined
): string {
  if (!from && !to) {
    return "All time periods";
  }

  if (relativeTimeSeconds !== undefined) {
    return timeFrameValues.find((t) => t.value === relativeTimeSeconds)?.label ?? "Timeframe";
  }

  let fromString = from ? formatDateTime(new Date(from), "UTC", ["en-US"], false, true) : undefined;
  let toString = to ? formatDateTime(new Date(to), "UTC", ["en-US"], false, true) : undefined;
  if (from && !to) {
    return `From ${fromString} (UTC)`;
  }

  if (!from && to) {
    return `To ${toString} (UTC)`;
  }

  return `${fromString} - ${toString} (UTC)`;
}

function RelativeTimeFrame({
  value,
  onValueChange,
}: {
  value?: number;
  onValueChange: (value: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 pt-2">
      {timeFrameValues.map((timeframe) => (
        <Button
          key={timeframe.value}
          variant={value === timeframe.value ? "primary/small" : "tertiary/small"}
          className={cn(
            "w-full",
            value !== timeframe.value &&
              "border border-charcoal-700 text-xs group-hover:bg-charcoal-700"
          )}
          onClick={() => {
            onValueChange(timeframe.value);
          }}
        >
          {timeframe.label}
        </Button>
      ))}
    </div>
  );
}

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

export function AbsoluteTimeFrame({
  from,
  to,
  onValueChange,
}: {
  from?: Date;
  to?: Date;
  onValueChange: (value: { from?: Date; to?: Date }) => void;
}) {
  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex flex-col justify-start gap-2">
        <div className="space-y-1">
          <Label>From (UTC)</Label>
          <DateField
            label="From (UTC)"
            defaultValue={from}
            onValueChange={(value) => {
              onValueChange({ from: value, to: to });
            }}
            granularity="second"
            showNowButton
            showClearButton
            utc
          />
        </div>
        <div className="space-y-1">
          <Label>To (UTC)</Label>
          <DateField
            label="To (UTC)"
            defaultValue={to}
            onValueChange={(value) => {
              onValueChange({ from: from, to: value });
            }}
            granularity="second"
            showNowButton
            showClearButton
            utc
          />
        </div>
      </div>
    </div>
  );
}
