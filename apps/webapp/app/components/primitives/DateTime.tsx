import { Fragment, useEffect, useState } from "react";
import { useLocales } from "./LocaleProvider";

type DateTimeProps = {
  date: Date | string;
  timeZone?: string;
  includeSeconds?: boolean;
};

export const DateTime = ({ date, timeZone = "UTC", includeSeconds = true }: DateTimeProps) => {
  const locales = useLocales();

  const realDate = typeof date === "string" ? new Date(date) : date;

  const initialFormattedDateTime = formatDateTime(realDate, timeZone, locales, includeSeconds);

  const [formattedDateTime, setFormattedDateTime] = useState<string>(initialFormattedDateTime);

  useEffect(() => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();

    setFormattedDateTime(
      formatDateTime(realDate, resolvedOptions.timeZone, locales, includeSeconds)
    );
  }, [locales, includeSeconds, realDate]);

  return <Fragment>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</Fragment>;
};

function formatDateTime(
  date: Date,
  timeZone: string,
  locales: string[],
  includeSeconds: boolean
): string {
  return new Intl.DateTimeFormat(locales, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: includeSeconds ? "numeric" : undefined,
    timeZone,
  }).format(date);
}

export const DateTimeAccurate = ({ date, timeZone = "UTC" }: DateTimeProps) => {
  const locales = useLocales();

  const realDate = typeof date === "string" ? new Date(date) : date;

  const initialFormattedDateTime = formatDateTimeAccurate(realDate, timeZone, locales);

  const [formattedDateTime, setFormattedDateTime] = useState<string>(initialFormattedDateTime);

  useEffect(() => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();

    setFormattedDateTime(formatDateTimeAccurate(realDate, resolvedOptions.timeZone, locales));
  }, [locales, realDate]);

  return <Fragment>{formattedDateTime.replace(/\s/g, String.fromCharCode(32))}</Fragment>;
};

function formatDateTimeAccurate(date: Date, timeZone: string, locales: string[]): string {
  const milliseconds = `00${date.getMilliseconds()}`.slice(-3);

  const formattedDateTime = new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  }).format(date);

  return `${formatDateTime}.${milliseconds}`;
}
