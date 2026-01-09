import { CalendarDateTime, createCalendar } from "@internationalized/date";
import { useDateField, useDateSegment } from "@react-aria/datepicker";
import {
  useDateFieldState,
  type DateFieldState,
  type DateSegment,
} from "@react-stately/datepicker";
import { type Granularity } from "@react-types/datepicker";
import { useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { Button } from "./Buttons";

const variants = {
  small: {
    fieldStyles: "h-5 text-xs rounded-sm px-0.5",
    nowButtonVariant: "tertiary/small" as const,
    clearButtonVariant: "tertiary/small" as const,
  },
  medium: {
    fieldStyles: "h-7 text-sm rounded px-1",
    nowButtonVariant: "tertiary/medium" as const,
    clearButtonVariant: "minimal/medium" as const,
  },
};

type Variant = keyof typeof variants;

type DateFieldProps = {
  label: string;
  defaultValue?: Date;
  minValue?: Date;
  maxValue?: Date;
  className?: string;
  fieldClassName?: string;
  granularity: Granularity;
  showGuide?: boolean;
  showNowButton?: boolean;
  showClearButton?: boolean;
  onValueChange?: (value: Date | undefined) => void;
  utc?: boolean;
  variant?: Variant;
};

const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function DateField({
  label,
  defaultValue,
  onValueChange,
  minValue,
  maxValue,
  granularity,
  className,
  fieldClassName,
  showGuide = false,
  showNowButton = false,
  showClearButton = false,
  utc = false,
  variant = "small",
}: DateFieldProps) {
  const [value, setValue] = useState<undefined | CalendarDateTime>(
    utc ? utcDateToCalendarDate(defaultValue) : dateToCalendarDate(defaultValue)
  );

  const state = useDateFieldState({
    value: value,
    onChange: (value) => {
      if (value) {
        setValue(value);
        onValueChange?.(value.toDate(utc ? "utc" : deviceTimezone));
      }
    },
    minValue: utc ? utcDateToCalendarDate(minValue) : dateToCalendarDate(minValue),
    maxValue: utc ? utcDateToCalendarDate(maxValue) : dateToCalendarDate(maxValue),
    shouldForceLeadingZeros: true,
    granularity,
    locale: "en-US",
    createCalendar: (name: string) => {
      return createCalendar(name);
    },
  });

  //if the passed in value changes, we should update the date
  useEffect(() => {
    if (state.value === undefined && defaultValue === undefined) return;

    const calendarDate = utc
      ? utcDateToCalendarDate(defaultValue)
      : dateToCalendarDate(defaultValue);
    //unchanged
    if (state.value?.toDate("utc").getTime() === defaultValue?.getTime()) {
      return;
    }

    setValue(calendarDate);
  }, [defaultValue]);

  const ref = useRef<null | HTMLDivElement>(null);
  const { labelProps, fieldProps } = useDateField(
    {
      label,
    },
    state,
    ref
  );

  //render if reverse date order
  const yearSegment = state.segments.find((s) => s.type === "year")!;
  const monthSegment = state.segments.find((s) => s.type === "month")!;
  const daySegment = state.segments.find((s) => s.type === "day")!;
  const hourSegment = state.segments.find((s) => s.type === "hour")!;
  const minuteSegment = state.segments.find((s) => s.type === "minute")!;
  const secondSegment = state.segments.find((s) => s.type === "second")!;
  const dayPeriodSegment = state.segments.find((s) => s.type === "dayPeriod")!;

  return (
    <div className={`flex flex-col items-start ${className || ""}`}>
      <div className="flex flex-row items-center gap-1" aria-label={label}>
        <div
          {...fieldProps}
          ref={ref}
          className={cn(
            "flex rounded-sm border bg-charcoal-700 p-0.5 transition focus-within:border-charcoal-600 hover:border-charcoal-600",
            fieldClassName
          )}
        >
          <DateSegment segment={yearSegment} state={state} variant={variant} />
          <DateSegment segment={literalSegment("/")} state={state} variant={variant} />
          <DateSegment segment={monthSegment} state={state} variant={variant} />
          <DateSegment segment={literalSegment("/")} state={state} variant={variant} />
          <DateSegment segment={daySegment} state={state} variant={variant} />
          <DateSegment segment={literalSegment(", ")} state={state} variant={variant} />
          <DateSegment segment={hourSegment} state={state} variant={variant} />
          <DateSegment segment={literalSegment(":")} state={state} variant={variant} />
          <DateSegment segment={minuteSegment} state={state} variant={variant} />
          <DateSegment segment={literalSegment(":")} state={state} variant={variant} />
          <DateSegment segment={secondSegment} state={state} variant={variant} />
          <DateSegment segment={literalSegment(" ")} state={state} variant={variant} />
          <DateSegment segment={dayPeriodSegment} state={state} variant={variant} />
        </div>
        {showNowButton && (
          <Button
            type="button"
            variant={variants[variant].nowButtonVariant}
            onClick={() => {
              const now = new Date();
              setValue(utc ? utcDateToCalendarDate(now) : dateToCalendarDate(now));
              onValueChange?.(now);
            }}
          >
            Now
          </Button>
        )}
        {showClearButton && (
          <Button
            type="button"
            variant={variants[variant].clearButtonVariant}
            onClick={() => {
              setValue(undefined);
              onValueChange?.(undefined);
              state.clearSegment("year");
              state.clearSegment("month");
              state.clearSegment("day");
              state.clearSegment("hour");
              state.clearSegment("minute");
              state.clearSegment("second");
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {showGuide && (
        <div className="mt-1 flex px-2">
          {state.segments.map((segment, i) => (
            <DateSegmentGuide key={i} segment={segment} />
          ))}
        </div>
      )}
    </div>
  );
}

function utcDateToCalendarDate(date?: Date) {
  return date
    ? new CalendarDateTime(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds()
      )
    : undefined;
}

function dateToCalendarDate(date?: Date) {
  return date
    ? new CalendarDateTime(
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds()
      )
    : undefined;
}

type DateSegmentProps = {
  segment: DateSegment;
  state: DateFieldState;
  variant: Variant;
};

function DateSegment({ segment, state, variant }: DateSegmentProps) {
  const ref = useRef<null | HTMLDivElement>(null);
  const { segmentProps } = useDateSegment(segment, state, ref);
  const sizeVariant = variants[variant];

  return (
    <div
      {...segmentProps}
      ref={ref}
      style={{
        ...segmentProps.style,
        minWidth: minWidthForSegment(segment),
      }}
      className={cn(
        "group box-content text-center tabular-nums outline-none focus:bg-charcoal-600 focus:text-text-bright",
        sizeVariant.fieldStyles,
        !segment.isEditable ? "text-charcoal-500" : "text-text-bright"
      )}
    >
      {/* Always reserve space for the placeholder, to prevent layout shift when editing. */}
      <span
        aria-hidden="true"
        className="flex h-full items-center justify-center text-center text-charcoal-500 group-focus:text-text-bright"
        style={{
          visibility: segment.isPlaceholder ? undefined : "hidden",
          height: segment.isPlaceholder ? undefined : 0,
          pointerEvents: "none",
        }}
      >
        {segment.placeholder}
      </span>
      <span className="flex h-full items-center justify-center">
        {segment.isPlaceholder ? "" : segment.text}
      </span>
    </div>
  );
}

function literalSegment(text: string): DateSegment {
  return {
    type: "literal",
    text,
    isPlaceholder: false,
    isEditable: false,
    placeholder: "",
  };
}

function minWidthForSegment(segment: DateSegment) {
  if (segment.type === "literal") {
    return undefined;
  }

  return String(`${segment.maxValue}`).length + "ch";
}

function DateSegmentGuide({ segment }: { segment: DateSegment }) {
  return (
    <div
      style={{
        minWidth: minWidthForSegment(segment),
      }}
      className={`group box-content rounded-sm px-0.5 text-right text-sm tabular-nums text-rose-500 outline-none ${
        !segment.isEditable ? "text-charcoal-500" : "text-text-bright"
      }`}
    >
      <span className="block text-center italic text-charcoal-500">
        {segment.type !== "literal" ? segment.placeholder : segment.text}
      </span>
    </div>
  );
}
