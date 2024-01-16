import { CalendarDateTime, createCalendar } from "@internationalized/date";
import { useDateField, useDateSegment } from "@react-aria/datepicker";
import type { DateFieldState, DateSegment } from "@react-stately/datepicker";
import { useDateFieldState } from "@react-stately/datepicker";
import { Granularity } from "@react-types/datepicker";
import { useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { useLocales } from "./LocaleProvider";
import { Button } from "./Buttons";

type DateFieldProps = {
  label?: string;
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
};

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
}: DateFieldProps) {
  const [value, setValue] = useState<undefined | CalendarDateTime>(
    utcDateToCalendarDate(defaultValue)
  );

  const locales = useLocales();

  const state = useDateFieldState({
    value: value,
    onChange: (value) => {
      if (value) {
        setValue(value);
        onValueChange?.(value.toDate("utc"));
      }
    },
    minValue: utcDateToCalendarDate(minValue),
    maxValue: utcDateToCalendarDate(maxValue),
    granularity,
    locale: locales.at(0) ?? "en-US",
    createCalendar: (name: string) => {
      return createCalendar(name);
    },
  });

  //if the passed in value changes, we should update the date
  useEffect(() => {
    if (state.value === undefined && defaultValue === undefined) return;

    const calendarDate = utcDateToCalendarDate(defaultValue);
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

  return (
    <div className={`flex flex-col items-start ${className || ""}`}>
      <span {...labelProps} className="mb-1 ml-0.5 text-xs text-slate-300">
        {label}
      </span>
      <div className="flex flex-row items-center gap-1">
        <div
          {...fieldProps}
          ref={ref}
          className={cn(
            "flex rounded-sm border border-slate-800 bg-midnight-900 p-0.5 px-1.5 transition-colors focus-within:border-slate-500 hover:border-slate-700 focus-within:hover:border-slate-500",
            fieldClassName
          )}
        >
          {state.segments.map((segment, i) => (
            <DateSegment key={i} segment={segment} state={state} />
          ))}
        </div>
        {showNowButton && (
          <Button
            variant="secondary/small"
            onClick={() => {
              const now = new Date();
              setValue(utcDateToCalendarDate(new Date()));
              onValueChange?.(now);
            }}
          >
            Now
          </Button>
        )}
        {showClearButton && (
          <Button
            variant="secondary/small"
            LeadingIcon={"close"}
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
          />
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
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds()
      )
    : undefined;
}

type DateSegmentProps = {
  segment: DateSegment;
  state: DateFieldState;
};

function DateSegment({ segment, state }: DateSegmentProps) {
  const ref = useRef<null | HTMLDivElement>(null);
  const { segmentProps } = useDateSegment(segment, state, ref);

  return (
    <div
      {...segmentProps}
      ref={ref}
      style={{
        ...segmentProps.style,
        minWidth: minWidthForSegment(segment),
      }}
      className={`group box-content rounded-sm px-0.5 text-right text-sm tabular-nums outline-none focus:bg-indigo-500 focus:text-white ${
        !segment.isEditable ? "text-slate-500" : "text-bright"
      }`}
    >
      {/* Always reserve space for the placeholder, to prevent layout shift when editing. */}
      <span
        aria-hidden="true"
        className="block text-center italic text-slate-500 group-focus:text-white"
        style={{
          visibility: segment.isPlaceholder ? undefined : "hidden",
          height: segment.isPlaceholder ? "" : 0,
          pointerEvents: "none",
        }}
      >
        {segment.placeholder}
      </span>
      {segment.isPlaceholder ? "" : segment.text}
    </div>
  );
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
      className={`group box-content rounded-sm px-0.5 text-right text-sm tabular-nums outline-none ${
        !segment.isEditable ? "text-slate-500" : "text-bright"
      }`}
    >
      <span className="block text-center italic text-slate-500">
        {segment.type !== "literal" ? segment.placeholder : segment.text}
      </span>
    </div>
  );
}
