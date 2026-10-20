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
  row: {
    fieldStyles: "h-5 text-sm rounded-sm px-0.5",
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
  borderless?: boolean;
  dayFirst?: boolean;
  hourCycle?: 12 | 24;
  autoFocus?: boolean;
  invalid?: boolean;
  onInvalidInput?: () => void;
};

const RANGED_SEGMENTS = new Set(["day", "month", "hour", "minute"]);

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
  borderless = false,
  dayFirst = false,
  hourCycle,
  autoFocus = false,
  invalid = false,
  onInvalidInput,
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
    hourCycle,
    locale: "en-US",
    createCalendar: (name: string) => {
      return createCalendar(name);
    },
  });

  const stateValueRef = useRef(state.value);
  // oxlint-disable-next-line react/refs -- This ref intentionally coordinates an imperative integration outside React state.
  stateValueRef.current = state.value;

  // Sync only when the passed value or timezone mode changes. Depending on state.value directly
  // would reset partially edited segments back to the default after every keystroke.
  useEffect(() => {
    const stateValue = stateValueRef.current;
    if (stateValue === undefined && defaultValue === undefined) return;

    const calendarDate = utc
      ? utcDateToCalendarDate(defaultValue)
      : dateToCalendarDate(defaultValue);
    // unchanged
    if (stateValue?.toDate(utc ? "utc" : deviceTimezone).getTime() === defaultValue?.getTime()) {
      return;
    }

    setValue(calendarDate);
  }, [defaultValue, utc]);

  const ref = useRef<null | HTMLDivElement>(null);
  const { labelProps: _labelProps, fieldProps } = useDateField(
    {
      label,
    },
    state,
    ref
  );

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- focus once on mount

  const typed = useRef({ type: "", keys: "" });
  useEffect(() => {
    const field = ref.current;
    if (!field || hourCycle !== 24) return;
    const reset = () => {
      typed.current = { type: "", keys: "" };
    };
    const onBeforeInput = (e: InputEvent) => {
      const el =
        e.target instanceof Element ? e.target.closest<HTMLElement>("[data-segment-type]") : null;
      const type = el?.dataset.segmentType;
      if (!type || !RANGED_SEGMENTS.has(type) || !e.data || !/^\d$/.test(e.data)) return;
      const segment = state.segments.find((s) => s.type === type);
      if (!segment) return;
      const keys = (typed.current.type === type ? typed.current.keys : "") + e.data;
      const max = segment.maxValue ?? Infinity;
      const width = String(max).length;
      const n = Number(keys);
      if (n > max || (keys.length >= width && n < (segment.minValue ?? 0))) {
        e.preventDefault();
        e.stopPropagation();
        reset();
        onInvalidInput?.();
        return;
      }
      typed.current = {
        type,
        keys: Number(`${keys}0`) > max || keys.length >= width ? "" : keys,
      };
    };
    field.addEventListener("beforeinput", onBeforeInput, true);
    field.addEventListener("focusin", reset);
    return () => {
      field.removeEventListener("beforeinput", onBeforeInput, true);
      field.removeEventListener("focusin", reset);
    };
  });

  //render if reverse date order
  const yearSegment = state.segments.find((s) => s.type === "year")!;
  const monthSegment = state.segments.find((s) => s.type === "month")!;
  const daySegment = state.segments.find((s) => s.type === "day")!;
  const hourSegment = state.segments.find((s) => s.type === "hour")!;
  const minuteSegment = state.segments.find((s) => s.type === "minute")!;
  const secondSegment = state.segments.find((s) => s.type === "second");
  const dayPeriodSegment = state.segments.find((s) => s.type === "dayPeriod");
  const [firstSegment, lastSegment] = dayFirst
    ? [daySegment, yearSegment]
    : [yearSegment, daySegment];

  return (
    <div className={`flex flex-col items-start ${className || ""}`}>
      <div className="flex flex-row items-center gap-1" aria-label={label}>
        <div
          {...fieldProps}
          ref={ref}
          className={cn(
            "flex rounded-sm transition",
            !borderless &&
              "border bg-background-raised p-0.5 focus-within:border-border-bright hover:border-border-bright",
            invalid && "border-error text-error",
            fieldClassName
          )}
        >
          <DateSegment segment={firstSegment} state={state} variant={variant} invalid={invalid} />
          <DateSegment
            segment={literalSegment("/")}
            state={state}
            variant={variant}
            invalid={invalid}
          />
          <DateSegment segment={monthSegment} state={state} variant={variant} invalid={invalid} />
          <DateSegment
            segment={literalSegment("/")}
            state={state}
            variant={variant}
            invalid={invalid}
          />
          <DateSegment segment={lastSegment} state={state} variant={variant} invalid={invalid} />
          <DateSegment
            segment={literalSegment(", ")}
            state={state}
            variant={variant}
            invalid={invalid}
          />
          <DateSegment segment={hourSegment} state={state} variant={variant} invalid={invalid} />
          <DateSegment
            segment={literalSegment(":")}
            state={state}
            variant={variant}
            invalid={invalid}
          />
          <DateSegment segment={minuteSegment} state={state} variant={variant} invalid={invalid} />
          {secondSegment && (
            <>
              <DateSegment
                segment={literalSegment(":")}
                state={state}
                variant={variant}
                invalid={invalid}
              />
              <DateSegment
                segment={secondSegment}
                state={state}
                variant={variant}
                invalid={invalid}
              />
            </>
          )}
          {dayPeriodSegment && (
            <>
              <DateSegment
                segment={literalSegment(" ")}
                state={state}
                variant={variant}
                invalid={invalid}
              />
              <DateSegment
                segment={dayPeriodSegment}
                state={state}
                variant={variant}
                invalid={invalid}
              />
            </>
          )}
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
  invalid?: boolean;
};

function DateSegment({ segment, state, variant, invalid }: DateSegmentProps) {
  const ref = useRef<null | HTMLDivElement>(null);
  const { segmentProps } = useDateSegment(segment, state, ref);
  const sizeVariant = variants[variant];

  return (
    <div
      {...segmentProps}
      ref={ref}
      data-segment-type={segment.type}
      style={{
        ...segmentProps.style,
        minWidth: minWidthForSegment(segment),
      }}
      className={cn(
        "group box-content text-center tabular-nums outline-hidden focus:bg-surface-control focus:text-text-bright",
        sizeVariant.fieldStyles,
        !segment.isEditable ? "text-text-faint" : invalid ? "text-error" : "text-text-bright"
      )}
    >
      {/* Always reserve space for the placeholder, to prevent layout shift when editing. */}
      <span
        aria-hidden="true"
        className="flex h-full items-center justify-center text-center text-text-faint group-focus:text-text-bright"
        style={{
          visibility: segment.isPlaceholder ? undefined : "hidden",
          height: segment.isPlaceholder ? undefined : 0,
          pointerEvents: "none",
        }}
      >
        {segment.placeholder}
      </span>
      <span
        className="flex h-full items-center justify-center"
        style={{ height: segment.isPlaceholder ? 0 : undefined }}
      >
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
      className={`group box-content rounded-sm px-0.5 text-right text-sm tabular-nums outline-hidden ${
        !segment.isEditable ? "text-text-faint" : "text-text-bright"
      }`}
    >
      <span className="block text-center italic text-text-faint">
        {segment.type !== "literal" ? segment.placeholder : segment.text}
      </span>
    </div>
  );
}
