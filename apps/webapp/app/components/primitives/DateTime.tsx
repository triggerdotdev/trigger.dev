import { GlobeAltIcon, GlobeAmericasIcon } from "@heroicons/react/20/solid";
import { Laptop } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";
import { useLocales } from "./LocaleProvider";
import { Paragraph } from "./Paragraph";
import { SimpleTooltip } from "./Tooltip";

type DateTimeProps = {
  date: Date | string;
  timeZone?: string;
  includeSeconds?: boolean;
  includeTime?: boolean;
  showTimezone?: boolean;
  showTooltip?: boolean;
  previousDate?: Date | string | null; // Add optional previous date for comparison
};

export const DateTime = ({
  date,
  timeZone,
  includeSeconds = true,
  includeTime = true,
  showTimezone = false,
  showTooltip = true,
}: DateTimeProps) => {
  const locales = useLocales();
  const [localTimeZone, setLocalTimeZone] = useState<string>("UTC");

  const realDate = typeof date === "string" ? new Date(date) : date;

  useEffect(() => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    setLocalTimeZone(resolvedOptions.timeZone);
  }, []);

  const tooltipContent = (
    <TooltipContent
      realDate={realDate}
      timeZone={timeZone}
      localTimeZone={localTimeZone}
      locales={locales}
    />
  );

  const formattedDateTime = (
    <Fragment>
      {formatDateTime(
        realDate,
        timeZone ?? localTimeZone,
        locales,
        includeSeconds,
        includeTime
      ).replace(/\s/g, String.fromCharCode(32))}
      {showTimezone ? ` (${timeZone ?? "UTC"})` : null}
    </Fragment>
  );

  if (!showTooltip) return formattedDateTime;

  return <SimpleTooltip button={formattedDateTime} content={tooltipContent} side="right" />;
};

export function formatDateTime(
  date: Date,
  timeZone: string,
  locales: string[],
  includeSeconds: boolean,
  includeTime: boolean
): string {
  return new Intl.DateTimeFormat(locales, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: includeTime ? "numeric" : undefined,
    minute: includeTime ? "numeric" : undefined,
    second: includeTime && includeSeconds ? "numeric" : undefined,
    timeZone,
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
export const SmartDateTime = ({ date, previousDate = null, timeZone = "UTC" }: DateTimeProps) => {
  const locales = useLocales();
  const realDate = typeof date === "string" ? new Date(date) : date;
  const realPrevDate = previousDate
    ? typeof previousDate === "string"
      ? new Date(previousDate)
      : previousDate
    : null;

  // Initial formatted values
  const initialTimeOnly = formatTimeOnly(realDate, timeZone, locales);
  const initialWithDate = formatSmartDateTime(realDate, timeZone, locales);

  // State for the formatted time
  const [formattedDateTime, setFormattedDateTime] = useState<string>(
    realPrevDate && isSameDay(realDate, realPrevDate) ? initialTimeOnly : initialWithDate
  );

  useEffect(() => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    const userTimeZone = resolvedOptions.timeZone;

    // Check if we should show the date
    const showDatePart = !realPrevDate || !isSameDay(realDate, realPrevDate);

    // Format with appropriate function
    setFormattedDateTime(
      showDatePart
        ? formatSmartDateTime(realDate, userTimeZone, locales)
        : formatTimeOnly(realDate, userTimeZone, locales)
    );
  }, [locales, realDate, realPrevDate]);

  return <Fragment>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</Fragment>;
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
function formatSmartDateTime(date: Date, timeZone: string, locales: string[]): string {
  return new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
  }).format(date);
}

// Format time only
function formatTimeOnly(date: Date, timeZone: string, locales: string[]): string {
  return new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
  }).format(date);
}

export const DateTimeAccurate = ({
  date,
  timeZone = "UTC",
  previousDate = null,
  showTooltip = true,
}: DateTimeProps) => {
  const locales = useLocales();
  const [localTimeZone, setLocalTimeZone] = useState<string>("UTC");
  const realDate = typeof date === "string" ? new Date(date) : date;
  const realPrevDate = previousDate
    ? typeof previousDate === "string"
      ? new Date(previousDate)
      : previousDate
    : null;

  useEffect(() => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    setLocalTimeZone(resolvedOptions.timeZone);
  }, []);

  // Smart formatting based on whether date changed
  const formattedDateTime = realPrevDate
    ? isSameDay(realDate, realPrevDate)
      ? formatTimeOnly(realDate, localTimeZone, locales)
      : formatDateTimeAccurate(realDate, localTimeZone, locales)
    : formatDateTimeAccurate(realDate, localTimeZone, locales);

  if (!showTooltip)
    return <Fragment>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</Fragment>;

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
      button={<Fragment>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</Fragment>}
      content={tooltipContent}
      side="right"
    />
  );
};

function formatDateTimeAccurate(date: Date, timeZone: string, locales: string[]): string {
  const formattedDateTime = new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
  }).format(date);

  return formattedDateTime;
}

export const DateTimeShort = ({ date, timeZone = "UTC" }: DateTimeProps) => {
  const locales = useLocales();
  const realDate = typeof date === "string" ? new Date(date) : date;
  const initialFormattedDateTime = formatDateTimeShort(realDate, timeZone, locales);
  const [formattedDateTime, setFormattedDateTime] = useState<string>(initialFormattedDateTime);

  useEffect(() => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    setFormattedDateTime(formatDateTimeShort(realDate, resolvedOptions.timeZone, locales));
  }, [locales, realDate]);

  return <Fragment>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</Fragment>;
};

function formatDateTimeShort(date: Date, timeZone: string, locales: string[]): string {
  const formattedDateTime = new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore fractionalSecondDigits works in most modern browsers
    fractionalSecondDigits: 3,
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
  const getUtcOffset = () => {
    if (title !== "Local") return "";
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hours = Math.abs(Math.floor(offset / 60));
    const minutes = Math.abs(offset % 60);
    return `(UTC ${sign}${hours}${minutes ? `:${minutes.toString().padStart(2, "0")}` : ""})`;
  };

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
            dateTime={formatDateTime(realDate, timeZone, locales, true, true)}
            isoDateTime={formatDateTimeISO(realDate, timeZone)}
            icon={<GlobeAmericasIcon className="size-4 text-purple-500" />}
          />
        )}
        <DateTimeTooltipContent
          title="UTC"
          dateTime={formatDateTime(realDate, "UTC", locales, true, true)}
          isoDateTime={formatDateTimeISO(realDate, "UTC")}
          icon={<GlobeAltIcon className="size-4 text-blue-500" />}
        />
        <DateTimeTooltipContent
          title="Local"
          dateTime={formatDateTime(realDate, localTimeZone, locales, true, true)}
          isoDateTime={formatDateTimeISO(realDate, localTimeZone)}
          icon={<Laptop className="size-4 text-green-500" />}
        />
      </div>
    </div>
  );
}
