import { CalendarDateTime, createCalendar } from "@internationalized/date";
import {
  AriaDateFieldOptions,
  DateValue,
  useDateField,
  useDateSegment,
} from "@react-aria/datepicker";
import type { DateFieldState, DateFieldStateOptions, DateSegment } from "@react-stately/datepicker";
import { useDateFieldState } from "@react-stately/datepicker";
import { useRef } from "react";
import { cn } from "~/utils/cn";
import { useLocales } from "./LocaleProvider";
import { Prettify } from "@trigger.dev/core";

type DateFieldProps = {
  label?: string;
  defaultValue?: Date;
  className?: string;
  fieldClassName?: string;
  onValueChange?: (value: Date) => void;
};

export function DateField({
  label,
  defaultValue,
  onValueChange,
  className,
  fieldClassName,
}: DateFieldProps) {
  const locales = useLocales();

  const state = useDateFieldState({
    defaultValue: utcDateToCalendarDate(defaultValue),
    onChange: (value) => {
      if (value) {
        onValueChange?.(value.toDate("utc"));
      }
    },
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
      <span {...labelProps} className="text-sm text-slate-400">
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
        minWidth:
          segment.type !== "literal" && segment.maxValue !== null
            ? String(`${segment.maxValue}`).length + "ch"
            : undefined,
      }}
      className={`group box-content rounded-sm px-0.5 text-right tabular-nums outline-none focus:bg-indigo-500 focus:text-white ${
        !segment.isEditable ? "text-slate-600" : "text-bright"
      }`}
    >
      {/* Always reserve space for the placeholder, to prevent layout shift when editing. */}
      <span
        aria-hidden="true"
        className="block text-center italic text-gray-500 group-focus:text-white"
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
