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
  const formattedDateTime = new Intl.DateTimeFormat(locales, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone,
    // @ts-ignore this works in 92.5% of browsers https://caniuse.com/mdn-javascript_builtins_intl_datetimeformat_datetimeformat_options_parameter_options_fractionalseconddigits_parameter
    fractionalSecondDigits: 3,
  }).format(date);

  return formattedDateTime;
}
