import { ChevronDownIcon } from "lucide-react";
import { useCallback, useState } from "react";
import {
  Calendar,
  CalendarDateTime,
  DateValue,
  getLocalTimeZone,
  today,
} from "@internationalized/date";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { ClientTabs, ClientTabsContent, ClientTabsWithUnderline } from "../primitives/ClientTabs";
import { formatDateTime } from "../primitives/DateTime";
import { Paragraph } from "../primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { DateField } from "../primitives/DateField";
import { useLocales } from "../primitives/LocaleProvider";
import { createCalendar } from "@internationalized/date";

type RunTimeFrameFilterProps = {
  from?: number;
  to?: number;
  onRangeChanged: (range: { from?: number; to?: number }) => void;
};

type Mode = "absolute" | "relative";

export function RunTimeFrameFilter({ from, to, onRangeChanged }: RunTimeFrameFilterProps) {
  const [activeTab, setActiveTab] = useState<Mode>("absolute");
  const [isOpen, setIsOpen] = useState(false);
  const [relativeTimeSeconds, setRelativeTimeSeconds] = useState<number | undefined>();

  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(to) : undefined;

  const getTitle = (from: number | undefined, to: number | undefined) => {
    if (!from || !to) {
      return "Timeframe";
    }

    if (relativeTimeSeconds !== undefined) {
      return timeFrameValues.find((t) => t.value === relativeTimeSeconds)?.label ?? "Timeframe";
    }

    const toDateTime = formatDateTime(new Date(to), "UTC", ["en-US"], false, true);
    const fromDateTime = formatDateTime(new Date(from), "UTC", ["en-US"], false, true);

    return `${fromDateTime} - ${toDateTime} (UTC)`;
  };

  const relativeTimeFrameChanged = useCallback((value: number) => {
    const to = new Date().getTime();
    const from = to - value;
    onRangeChanged({ from, to });
    setRelativeTimeSeconds(value);
  }, []);

  const absoluteTimeFrameChanged = useCallback(({ from, to }: { from?: Date; to?: Date }) => {
    const fromTime = from?.getTime();
    const toTime = to?.getTime();
    if (fromTime || toTime) {
      onRangeChanged({ from: fromTime, to: toTime });
    }
  }, []);

  return (
    <Popover onOpenChange={(open) => setIsOpen(open)} open={isOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="secondary/small"
          className="bg-slate-800 group-hover:bg-tertiary-foreground"
        >
          <Paragraph variant="extra-small" className="mr-2">
            {getTitle(from, to)}
          </Paragraph>
          <ChevronDownIcon className="h-4 w-4 text-bright" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="bg-popover p-2">
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
            value !== timeframe.value && "border border-slate-700 group-hover:bg-slate-700"
          )}
          onClick={() => {
            onValueChange(timeframe.value);
          }}
        >
          <Paragraph variant="extra-small">{timeframe.label}</Paragraph>
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

function AbsoluteTimeFrame({
  from,
  to,
  onValueChange,
}: {
  from?: Date;
  to?: Date;
  onValueChange: (value: { from?: Date; to?: Date }) => void;
}) {
  const locales = useLocales();
  const [fromDate, setFromDate] = useState<DateValue | undefined>(
    from
      ? new CalendarDateTime(
          from.getFullYear(),
          from.getMonth(),
          from.getDate(),
          from.getHours(),
          from.getMinutes(),
          from.getSeconds()
        )
      : undefined
  );
  const [toDate, setToDate] = useState<Date | undefined>(to);

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex flex-col justify-start gap-2">
        <DateField
          label="From"
          value={fromDate}
          onChange={(value) => {
            if (value) {
              setFromDate(value);
              onValueChange({ from: value.toDate("utc"), to: toDate });
            } else {
              console.log("fromDate is undefined");
            }
          }}
          maxValue={today(getLocalTimeZone())}
          granularity="second"
          shouldForceLeadingZeros={true}
          locale={locales.at(0) ?? "en-US"}
          createCalendar={function (name: string): Calendar {
            return createCalendar(name);
          }}
        />
      </div>
    </div>
  );
}
