import { useLocales } from "./LocaleProvider";

type IntlDateProps = {
  date: Date;
  timeZone?: string;
};

export const IntlDate = ({ date, timeZone }: IntlDateProps) => {
  const locales = useLocales();
  const isoString = date.toISOString();
  const formattedDate = new Intl.DateTimeFormat(locales, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(date);

  const formattedTime = new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "numeric",
    timeZone,
  }).format(date);

  return (
    <time dateTime={isoString}>
      {formattedDate} at {formattedTime}
    </time>
  );
};

export const LogDate = ({ date, timeZone }: IntlDateProps) => {
  const locales = useLocales();
  const isoString = date.toISOString();
  const formattedDate = new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "2-digit",
    timeZone,
  }).format(date);

  const formattedTime = new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);

  const milliseconds = `00${date.getMilliseconds()}`.slice(-3);

  return (
    <time dateTime={isoString}>
      {formattedDate} {formattedTime}.{milliseconds}
    </time>
  );
};
