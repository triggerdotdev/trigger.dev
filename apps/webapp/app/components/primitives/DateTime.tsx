import { GlobeAltIcon, GlobeAmericasIcon } from "@heroicons/react/20/solid";
import { Laptop } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useLocales } from "./LocaleProvider";
import { Paragraph } from "./Paragraph";
import { SimpleTooltip } from "./Tooltip";

type DateTimeProps = {
  date: Date | string;
  timeZone?: string;
  includeSeconds?: boolean;
  includeTime?: boolean;
  showTimezone?: boolean;
  previousDate?: Date | string | null; // Add optional previous date for comparison
};

export const DateTime = ({
  date,
  timeZone,
  includeSeconds = true,
  includeTime = true,
  showTimezone = false,
}: DateTimeProps) => {
  const locales = useLocales();
  const realDate = typeof date === "string" ? new Date(date) : date;
  const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
  const localTimeZone = resolvedOptions.timeZone;

  const initialFormattedDateTime = formatDateTime(
    realDate,
    timeZone ?? "UTC",
    locales,
    includeSeconds,
    includeTime
  );

  const [formattedDateTime, setFormattedDateTime] = useState<string>(initialFormattedDateTime);

  useEffect(() => {
    setFormattedDateTime(
      formatDateTime(
        realDate,
        timeZone ?? resolvedOptions.timeZone,
        locales,
        includeSeconds,
        includeTime
      )
    );
  }, [locales, includeSeconds, realDate]);

  const tooltipContent = (
    <div className="flex flex-col gap-1">
      {!timeZone || timeZone === "UTC" ? (
        <div className="flex flex-col gap-3">
          <DateTimeTooltipContent
            title="UTC"
            dateTime={formatDateTime(realDate, "UTC", locales, true, true)}
            icon={<GlobeAltIcon className="size-4 text-blue-500" />}
          />
          <DateTimeTooltipContent
            title="Local"
            dateTime={formatDateTime(realDate, localTimeZone, locales, true, true)}
            icon={<Laptop className="size-4 text-green-500" />}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <DateTimeTooltipContent
            title={timeZone}
            dateTime={formatDateTime(realDate, timeZone, locales, true, true)}
            icon={<GlobeAmericasIcon className="size-4 text-purple-500" />}
          />
          <DateTimeTooltipContent
            title="UTC"
            dateTime={formatDateTime(realDate, "UTC", locales, true, true)}
            icon={<GlobeAltIcon className="size-4 text-blue-500" />}
          />
          <DateTimeTooltipContent
            title="Local"
            dateTime={formatDateTime(realDate, localTimeZone, locales, true, true)}
            icon={<Laptop className="size-4 text-green-500" />}
          />
        </div>
      )}
    </div>
  );

  return (
    <SimpleTooltip
      button={
        <Fragment>
          {formattedDateTime.replace(/\s/g, String.fromCharCode(32))}
          {showTimezone ? ` (${timeZone ?? "UTC"})` : null}
        </Fragment>
      }
      content={tooltipContent}
      side="right"
      // disableHoverableContent
    />
  );
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
}: DateTimeProps) => {
  const locales = useLocales();
  const realDate = typeof date === "string" ? new Date(date) : date;
  const realPrevDate = previousDate
    ? typeof previousDate === "string"
      ? new Date(previousDate)
      : previousDate
    : null;

  // Use the new Smart formatting if previousDate is provided
  const initialFormattedDateTime = realPrevDate
    ? isSameDay(realDate, realPrevDate)
      ? formatTimeOnly(realDate, timeZone, locales)
      : formatDateTimeAccurate(realDate, timeZone, locales)
    : formatDateTimeAccurate(realDate, timeZone, locales);

  const [formattedDateTime, setFormattedDateTime] = useState<string>(initialFormattedDateTime);

  useEffect(() => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    const userTimeZone = resolvedOptions.timeZone;

    if (realPrevDate) {
      // Smart formatting based on whether date changed
      setFormattedDateTime(
        isSameDay(realDate, realPrevDate)
          ? formatTimeOnly(realDate, userTimeZone, locales)
          : formatDateTimeAccurate(realDate, userTimeZone, locales)
      );
    } else {
      // Default behavior when no previous date
      setFormattedDateTime(formatDateTimeAccurate(realDate, userTimeZone, locales));
    }
  }, [locales, realDate, realPrevDate]);

  return <Fragment>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</Fragment>;
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
  icon: ReactNode;
};

function DateTimeTooltipContent({ title, dateTime, icon }: DateTimeTooltipContentProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-sm">
        {icon}
        <span className="font-medium">{title}</span>
      </div>
      <Paragraph variant="extra-small" className="text-text-dimmed">
        {dateTime}
      </Paragraph>
    </div>
  );
}
