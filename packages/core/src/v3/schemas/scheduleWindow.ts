import { z } from "zod/v4";

export const MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS = 24 * 60 * 60;

export type NormalizedScheduleWindow =
  | { type: "duration"; durationSeconds: number }
  | { type: "percentage"; percentage: number };

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type DigitsBelow = {
  "0": never;
  "1": "0";
  "2": "0" | "1";
  "3": "0" | "1" | "2";
  "4": "0" | "1" | "2" | "3";
  "5": "0" | "1" | "2" | "3" | "4";
  "6": "0" | "1" | "2" | "3" | "4" | "5";
  "7": "0" | "1" | "2" | "3" | "4" | "5" | "6";
  "8": "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7";
  "9": "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
};

type DigitLength<
  Value extends string,
  Result extends 0[] = [],
> = Value extends `${Digit}${infer Rest}` ? DigitLength<Rest, [...Result, 0]> : Result;

type CompareEqualLength<
  A extends string,
  B extends string,
> = A extends `${infer ADigit extends Digit}${infer ARest}`
  ? B extends `${infer BDigit extends Digit}${infer BRest}`
    ? ADigit extends BDigit
      ? CompareEqualLength<ARest, BRest>
      : ADigit extends DigitsBelow[BDigit]
        ? "lt"
        : "gt"
    : "eq"
  : "eq";

type DecimalStringLTE<A extends string, B extends string> =
  DigitLength<A> extends DigitLength<B>
    ? CompareEqualLength<A, B> extends "gt"
      ? false
      : true
    : DigitLength<B> extends [...DigitLength<A>, ...0[]]
      ? true
      : false;

type IsCanonicalUnsignedInteger<Value extends string> = Value extends `${bigint}`
  ? Value extends `-${string}`
    ? false
    : true
  : false;

/** The literal validation error for a configured schedule window, or `never` when valid. */
export type ScheduleWindowError<Window extends string> = string extends Window
  ? never
  : Window extends `${infer Amount}m`
    ? IsCanonicalUnsignedInteger<Amount> extends false
      ? "⛔ window must be a whole non-negative number"
      : DecimalStringLTE<Amount, "1440"> extends true
        ? never
        : "⛔ window duration cannot exceed 24 hours"
    : Window extends `${infer Amount}h`
      ? IsCanonicalUnsignedInteger<Amount> extends false
        ? "⛔ window must be a whole non-negative number"
        : DecimalStringLTE<Amount, "24"> extends true
          ? never
          : "⛔ window duration cannot exceed 24 hours"
      : Window extends `${infer Amount}%`
        ? IsCanonicalUnsignedInteger<Amount> extends false
          ? "⛔ percentage must be a whole non-negative number"
          : DecimalStringLTE<Amount, "100"> extends true
            ? never
            : "⛔ percentage cannot exceed 100%"
        : '⛔ window must look like "30m", "2h", or "50%"';

/**
 * Preserves valid schedule-window literals and replaces invalid literals with a descriptive type
 * error. Wide `string` values pass through for authoritative runtime validation.
 */
export type ValidatedScheduleWindow<Window extends string | undefined> = Window extends string
  ? [ScheduleWindowError<Window>] extends [never]
    ? Window
    : ScheduleWindowError<Window>
  : Window;

/** Parses and normalizes the public schedule-window syntax. */
export function parseScheduleWindow(value: string): NormalizedScheduleWindow {
  const durationMatch = /^(0|[1-9]\d*)([mh])$/.exec(value);

  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2] as "m" | "h";
    const durationSeconds = amount * (unit === "m" ? 60 : 3_600);

    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds > MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS
    ) {
      throw new RangeError("Schedule window duration cannot exceed 24 hours");
    }

    return { type: "duration", durationSeconds };
  }

  const percentageMatch = /^(0|[1-9]\d*)%$/.exec(value);
  if (percentageMatch) {
    const percentage = Number(percentageMatch[1]);

    if (!Number.isSafeInteger(percentage) || percentage > 100) {
      throw new RangeError("Schedule window percentage cannot exceed 100%");
    }

    return { type: "percentage", percentage };
  }

  throw new TypeError(
    'Schedule window must be a whole duration such as "30m" or "2h", or a percentage such as "30%"'
  );
}

/** Runtime authority for public schedule-window values. */
export const ScheduleWindow = z.string().superRefine((value, ctx) => {
  try {
    parseScheduleWindow(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
