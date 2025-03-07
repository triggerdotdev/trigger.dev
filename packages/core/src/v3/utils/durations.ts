import humanizeDuration, { Unit } from "humanize-duration";

function dateDifference(date1: Date, date2: Date) {
  return Math.abs(date1.getTime() - date2.getTime());
}

type DurationOptions = {
  style?: "long" | "short";
  maxDecimalPoints?: number;
  units?: Unit[];
  maxUnits?: number;
};

export function formatDuration(
  start?: Date | null,
  end?: Date | null,
  options?: DurationOptions
): string {
  if (!start || !end) {
    return "–";
  }

  return formatDurationMilliseconds(dateDifference(start, end), options);
}

export function nanosecondsToMilliseconds(nanoseconds: number): number {
  return nanoseconds / 1_000_000;
}

export function millisecondsToNanoseconds(milliseconds: number): number {
  return milliseconds * 1_000_000;
}

export function formatDurationNanoseconds(nanoseconds: number, options?: DurationOptions): string {
  return formatDurationMilliseconds(nanosecondsToMilliseconds(nanoseconds), options);
}

const aboveOneSecondUnits = ["d", "h", "m", "s"] as Unit[];
const belowOneSecondUnits = ["ms"] as Unit[];

export function formatDurationMilliseconds(
  milliseconds: number,
  options?: DurationOptions
): string {
  let duration = humanizeDuration(milliseconds, {
    units: options?.units
      ? options.units
      : milliseconds < 1000
      ? belowOneSecondUnits
      : aboveOneSecondUnits,
    maxDecimalPoints: options?.maxDecimalPoints ?? 1,
    largest: options?.maxUnits ?? 2,
  });

  if (!options) {
    return duration;
  }

  switch (options.style) {
    case "short":
      duration = duration.replace(" milliseconds", "ms");
      duration = duration.replace(" millisecond", "ms");
      duration = duration.replace(" seconds", "s");
      duration = duration.replace(" second", "s");
      duration = duration.replace(" minutes", "m");
      duration = duration.replace(" minute", "m");
      duration = duration.replace(" hours", "h");
      duration = duration.replace(" hour", "h");
      duration = duration.replace(" days", "d");
      duration = duration.replace(" day", "d");
      duration = duration.replace(" weeks", "w");
      duration = duration.replace(" week", "w");
      duration = duration.replace(" months", "mo");
      duration = duration.replace(" month", "mo");
      duration = duration.replace(" years", "y");
      duration = duration.replace(" year", "y");
  }

  return duration;
}

export function formatDurationInDays(milliseconds: number): string {
  let duration = humanizeDuration(milliseconds, {
    maxDecimalPoints: 0,
    largest: 2,
    units: ["d"],
  });

  return duration;
}
