import { useLocales } from "./LocaleProvider";

type IntlDateProps = {
  date: Date | string;
  timeZone?: string;
};

export const IntlDate = ({ date, timeZone }: IntlDateProps) => {
  const realDate = typeof date === "string" ? new Date(date) : date;

  const locales = useLocales();
  const isoString = realDate.toISOString();
  const formattedDate = new Intl.DateTimeFormat(locales, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(realDate);

  const formattedTime = new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "numeric",
    timeZone,
  }).format(realDate);

  return (
    <time dateTime={isoString}>
      {formattedDate} at {formattedTime}
    </time>
  );
};

export const LogDate = ({ date, timeZone }: IntlDateProps) => {
  const realDate = typeof date === "string" ? new Date(date) : date;

  const locales = useLocales();
  const isoString = realDate.toISOString();
  const formattedDate = new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "2-digit",
    timeZone,
  }).format(realDate);

  const formattedTime = new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).format(realDate);

  const milliseconds = `00${realDate.getMilliseconds()}`.slice(-3);

  return (
    <time dateTime={isoString}>
      {formattedDate} {formattedTime}.{milliseconds}
    </time>
  );
};
