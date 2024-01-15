import { CalendarDateTime, createCalendar } from "@internationalized/date";
import { useDateField, useDateSegment } from "@react-aria/datepicker";
import type { DateFieldState, DateSegment } from "@react-stately/datepicker";
import { useDateFieldState } from "@react-stately/datepicker";
import { Granularity } from "@react-types/datepicker";
import { useRef } from "react";
import { cn } from "~/utils/cn";
import { useLocales } from "./LocaleProvider";

type DateFieldProps = {
  label?: string;
  defaultValue?: Date;
  minValue?: Date;
  maxValue?: Date;
  className?: string;
  fieldClassName?: string;
  granularity: Granularity;
  showGuide?: boolean;
  onValueChange?: (value: Date) => void;
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
}: DateFieldProps) {
  const locales = useLocales();

  const state = useDateFieldState({
    defaultValue: utcDateToCalendarDate(defaultValue),
    onChange: (value) => {
      if (value) {
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
      <div
        {...fieldProps}
        ref={ref}
        className={cn(
          "flex rounded-md border border-slate-800 bg-midnight-900 p-1 px-2 transition-colors focus-within:border-slate-500 hover:border-slate-700 focus-within:hover:border-slate-500",
          fieldClassName
        )}
      >
        {state.segments.map((segment, i) => (
          <DateSegment key={i} segment={segment} state={state} />
        ))}
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
        date.getFullYear(),
        date.getMonth(),
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
