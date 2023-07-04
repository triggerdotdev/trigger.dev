import { useLocales } from "./LocaleProvider";

type DateTimeProps = {
  date: Date | string;
  timeZone?: string;
  className?: string;
};

export const DateTime = ({
  date,
  timeZone = "UTC",
  className,
}: DateTimeProps) => {
  const realDate = typeof date === "string" ? new Date(date) : date;

  const locales = useLocales();
  const isoString = realDate.toISOString();

  return (
    <time dateTime={isoString} className={className}>
      {formattedDateTime(date, locales, timeZone)}
    </time>
  );
};

export function formattedDateTime(
  date: Date | string,
  locales: string[],
  timeZone: string = "UTC"
) {
  const realDate = typeof date === "string" ? new Date(date) : date;

  const formattedDate = new Intl.DateTimeFormat(locales, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(realDate);

  const formattedTime = new Intl.DateTimeFormat(locales, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(realDate);

  return `${formattedDate} at ${formattedTime}`;
}

export const DateTimeAccurate = ({ date, timeZone = "UTC" }: DateTimeProps) => {
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
