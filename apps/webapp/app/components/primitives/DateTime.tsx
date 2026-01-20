import { GlobeAltIcon, GlobeAmericasIcon } from "@heroicons/react/20/solid";
import { Laptop } from "lucide-react";
import { memo, type ReactNode, useMemo, useSyncExternalStore } from "react";
import { CopyButton } from "./CopyButton";
import { useLocales } from "./LocaleProvider";
import { Paragraph } from "./Paragraph";
import { SimpleTooltip } from "./Tooltip";

// Cache the browser's local timezone - resolved once and reused
let cachedLocalTimeZone: string | null = null;

function getLocalTimeZone(): string {
  if (cachedLocalTimeZone === null) {
    cachedLocalTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return cachedLocalTimeZone;
}

// For SSR compatibility: returns "UTC" on server, actual timezone on client
function subscribeToTimeZone() {
  // No-op - timezone doesn't change
  return () => { };
}

function getTimeZoneSnapshot(): string {
  return getLocalTimeZone();
}

function getServerTimeZoneSnapshot(): string {
  return "UTC";
}

/**
 * Hook to get the browser's local timezone.
 * Uses useSyncExternalStore for SSR compatibility - returns "UTC" on server,
 * actual timezone on client. The timezone is cached and only resolved once.
 */
export function useLocalTimeZone(): string {
  return useSyncExternalStore(subscribeToTimeZone, getTimeZoneSnapshot, getServerTimeZoneSnapshot);
}

type DateTimeProps = {
  date: Date | string;
  timeZone?: string;
  includeSeconds?: boolean;
  includeTime?: boolean;
  includeDate?: boolean;
  showTimezone?: boolean;
  showTooltip?: boolean;
  hideDate?: boolean;
  previousDate?: Date | string | null; // Add optional previous date for comparison
  hour12?: boolean;
};

export const DateTime = ({
  date,
  timeZone,
  includeSeconds = true,
  includeTime = true,
  includeDate = true,
  showTimezone = false,
  showTooltip = true,
  hour12 = true,
}: DateTimeProps) => {
  const locales = useLocales();
  const localTimeZone = useLocalTimeZone();

  const realDate = useMemo(() => (typeof date === "string" ? new Date(date) : date), [date]);

  const formattedDateTime = (
    <span suppressHydrationWarning>
      {formatDateTime(
        realDate,
        timeZone ?? localTimeZone,
        locales,
        includeSeconds,
        includeTime,
        includeDate,
        hour12
      ).replace(/\s/g, String.fromCharCode(32))}
      {showTimezone ? ` (${timeZone ?? "UTC"})` : null}
    </span>
  );

  if (!showTooltip) return formattedDateTime;

  return (
    <SimpleTooltip
      button={formattedDateTime}
      content={
        <TooltipContent
          realDate={realDate}
          timeZone={timeZone}
          localTimeZone={localTimeZone}
          locales={locales}
        />
      }
      side="right"
      asChild={true}
    />
  );
};

export function formatDateTime(
  date: Date,
  timeZone: string,
  locales: string[],
  includeSeconds: boolean,
  includeTime: boolean,
  includeDate: boolean = true,
  hour12: boolean = true
): string {
  return new Intl.DateTimeFormat(locales, {
    year: includeDate ? "numeric" : undefined,
    month: includeDate ? "short" : undefined,
    day: includeDate ? "numeric" : undefined,
    hour: includeTime ? "numeric" : undefined,
    minute: includeTime ? "numeric" : undefined,
    second: includeTime && includeSeconds ? "numeric" : undefined,
    timeZone,
    hour12,
  }).format(date);
}

export function formatDateTimeISO(date: Date, timeZone: string): string {
  // Special handling for UTC
  if (timeZone === "UTC") {
    return date.toISOString();
  }

  // Get the date parts in the target timezone
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Get the timezone offset for this specific date
  const timeZoneFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });

  const dateParts = Object.fromEntries(
    dateFormatter.formatToParts(date).map(({ type, value }) => [type, value])
  );

  const timeZoneParts = timeZoneFormatter.formatToParts(date);
  const offset =
    timeZoneParts.find((part) => part.type === "timeZoneName")?.value.replace("GMT", "") ||
    "+00:00";

  // Format: YYYY-MM-DDThh:mm:ss.sss±hh:mm
  return (
    `${dateParts.year}-${dateParts.month}-${dateParts.day}T` +
    `${dateParts.hour}:${dateParts.minute}:${dateParts.second}.${String(
      date.getMilliseconds()
    ).padStart(3, "0")}${offset}`
  );
}

// New component that only shows date when it changes
export const SmartDateTime = ({ date, previousDate = null, hour12 = true }: DateTimeProps) => {
  const locales = useLocales();
  const localTimeZone = useLocalTimeZone();
  const realDate = typeof date === "string" ? new Date(date) : date;
  const realPrevDate = previousDate
    ? typeof previousDate === "string"
      ? new Date(previousDate)
      : previousDate
    : null;

  // Check if we should show the date
  const showDatePart = !realPrevDate || !isSameDay(realDate, realPrevDate);

  // Format with appropriate function
  const formattedDateTime = showDatePart
    ? formatSmartDateTime(realDate, localTimeZone, locales, hour12)
    : formatTimeOnly(realDate, localTimeZone, locales, hour12);

  return <span suppressHydrationWarning>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</span>;
};

// Helper function to check if two dates are on the same day
function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

// Format with date and time
function formatSmartDateTime(
  date: Date,
  timeZone: string,
  locales: string[],
  hour12: boolean = true
): string {
  return new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
    hour12,
  }).format(date);
}

// Format time only
function formatTimeOnly(
  date: Date,
  timeZone: string,
  locales: string[],
  hour12: boolean = true
): string {
  return new Intl.DateTimeFormat(locales, {
    hour: "2-digit",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
    hour12,
  }).format(date);
}

const DateTimeAccurateInner = ({
  date,
  timeZone = "UTC",
  previousDate = null,
  showTooltip = true,
  hideDate = false,
  hour12 = true,
}: DateTimeProps) => {
  const locales = useLocales();
  const localTimeZone = useLocalTimeZone();
  const realDate = typeof date === "string" ? new Date(date) : date;
  const realPrevDate = previousDate
    ? typeof previousDate === "string"
      ? new Date(previousDate)
      : previousDate
    : null;

  // Smart formatting based on whether date changed
  const formattedDateTime = useMemo(() => {
    return hideDate
      ? formatTimeOnly(realDate, localTimeZone, locales, hour12)
      : realPrevDate
        ? isSameDay(realDate, realPrevDate)
          ? formatTimeOnly(realDate, localTimeZone, locales, hour12)
          : formatDateTimeAccurate(realDate, localTimeZone, locales, hour12)
        : formatDateTimeAccurate(realDate, localTimeZone, locales, hour12);
  }, [realDate, localTimeZone, locales, hour12, hideDate, previousDate]);

  if (!showTooltip)
    return <span suppressHydrationWarning>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</span>;

  const tooltipContent = (
    <TooltipContent
      realDate={realDate}
      timeZone={timeZone}
      localTimeZone={localTimeZone}
      locales={locales}
    />
  );

  return (
    <SimpleTooltip
      button={<span suppressHydrationWarning>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</span>}
      content={tooltipContent}
      side="right"
      asChild={true}
    />
  );
};

function areDateTimePropsEqual(prev: DateTimeProps, next: DateTimeProps): boolean {
  // Compare Date objects by timestamp value, not reference
  const prevTime = prev.date instanceof Date ? prev.date.getTime() : prev.date;
  const nextTime = next.date instanceof Date ? next.date.getTime() : next.date;
  if (prevTime !== nextTime) return false;

  const prevPrevTime =
    prev.previousDate instanceof Date ? prev.previousDate.getTime() : prev.previousDate;
  const nextPrevTime =
    next.previousDate instanceof Date ? next.previousDate.getTime() : next.previousDate;
  if (prevPrevTime !== nextPrevTime) return false;

  return (
    prev.timeZone === next.timeZone &&
    prev.showTooltip === next.showTooltip &&
    prev.hideDate === next.hideDate &&
    prev.hour12 === next.hour12
  );
}

export const DateTimeAccurate = memo(DateTimeAccurateInner, areDateTimePropsEqual);

function formatDateTimeAccurate(
  date: Date,
  timeZone: string,
  locales: string[],
  hour12: boolean = true
): string {
  const formattedDateTime = new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
    hour12,
  }).format(date);

  return formattedDateTime;
}

export const DateTimeShort = ({ date, hour12 = true }: DateTimeProps) => {
  const locales = useLocales();
  const localTimeZone = useLocalTimeZone();
  const realDate = typeof date === "string" ? new Date(date) : date;
  const formattedDateTime = formatDateTimeShort(realDate, localTimeZone, locales, hour12);

  return <span suppressHydrationWarning>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</span>;
};

function formatDateTimeShort(
  date: Date,
  timeZone: string,
  locales: string[],
  hour12: boolean = true
): string {
  const formattedDateTime = new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
    hour12,
  }).format(date);

  return formattedDateTime;
}

type DateTimeTooltipContentProps = {
  title: string;
  dateTime: string;
  isoDateTime: string;
  icon: ReactNode;
};

function DateTimeTooltipContent({
  title,
  dateTime,
  isoDateTime,
  icon,
}: DateTimeTooltipContentProps) {
  const getUtcOffset = useMemo(
    () => () => {
      if (title !== "Local") return "";
      const offset = -new Date().getTimezoneOffset();
      const sign = offset >= 0 ? "+" : "-";
      const hours = Math.abs(Math.floor(offset / 60));
      const minutes = Math.abs(offset % 60);
      return `(UTC ${sign}${hours}${minutes ? `:${minutes.toString().padStart(2, "0")}` : ""})`;
    },
    [title]
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-sm">
        {icon}
        <span className="font-medium">{title}</span>
        <span className="font-normal text-text-dimmed">{getUtcOffset()}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Paragraph variant="extra-small" className="text-text-dimmed">
          {dateTime}
        </Paragraph>
        <CopyButton value={isoDateTime} variant="icon" size="extra-small" showTooltip={false} />
      </div>
    </div>
  );
}

function TooltipContent({
  realDate,
  timeZone,
  localTimeZone,
  locales,
}: {
  realDate: Date;
  timeZone?: string;
  localTimeZone: string;
  locales: string[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-2.5 pb-1">
        {timeZone && timeZone !== "UTC" && (
          <DateTimeTooltipContent
            title={timeZone}
            dateTime={formatDateTime(realDate, timeZone, locales, true, true, true)}
            isoDateTime={formatDateTimeISO(realDate, timeZone)}
            icon={<GlobeAmericasIcon className="size-4 text-purple-500" />}
          />
        )}
        <DateTimeTooltipContent
          title="UTC"
          dateTime={formatDateTime(realDate, "UTC", locales, true, true, true)}
          isoDateTime={formatDateTimeISO(realDate, "UTC")}
          icon={<GlobeAltIcon className="size-4 text-blue-500" />}
        />
        <DateTimeTooltipContent
          title="Local"
          dateTime={formatDateTime(realDate, localTimeZone, locales, true, true, true)}
          isoDateTime={formatDateTimeISO(realDate, localTimeZone)}
          icon={<Laptop className="size-4 text-green-500" />}
        />
      </div>
    </div>
  );
}
