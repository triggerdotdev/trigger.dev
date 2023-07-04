import { useLocales } from "./LocaleProvider";

type DateTimeProps = {
  date: Date | string;
  timeZone?: string;
  className?: string;
};

export const DateTime = ({ date, timeZone, className }: DateTimeProps) => {
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

  console.log(
    `<DateTime> (formattedDate = ${formattedDate}) (formattedTime = ${formattedTime}) (isoString = ${isoString})`
  );

  return (
    <time dateTime={isoString} className={className}>
      {formattedDate} at {formattedTime}
    </time>
  );
};

export const DateTimeAccurate = ({ date, timeZone }: DateTimeProps) => {
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
