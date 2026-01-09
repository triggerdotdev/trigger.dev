"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { format } from "date-fns";
import { DayPicker, useDayPicker } from "react-day-picker";
import { cn } from "~/utils/cn";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

const navButtonClass =
  "size-7 rounded-[3px] bg-secondary border border-charcoal-600 text-text-bright hover:bg-charcoal-600 hover:border-charcoal-550 transition inline-flex items-center justify-center";

function CustomMonthCaption({ calendarMonth }: { calendarMonth: { date: Date } }) {
  const { goToMonth, nextMonth, previousMonth } = useDayPicker();

  return (
    <div className="flex w-full items-center justify-between px-1">
      <button
        type="button"
        className={navButtonClass}
        disabled={!previousMonth}
        onClick={() => previousMonth && goToMonth(previousMonth)}
        aria-label="Go to previous month"
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <div className="flex items-center gap-2">
        <select
          className="rounded border border-charcoal-600 bg-charcoal-750 px-2 py-1 text-sm text-text-bright focus:border-charcoal-500 focus:outline-none"
          value={calendarMonth.date.getMonth()}
          onChange={(e) => {
            const newDate = new Date(calendarMonth.date);
            newDate.setMonth(parseInt(e.target.value));
            goToMonth(newDate);
          }}
        >
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i} value={i}>
              {format(new Date(2000, i), "MMM")}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-charcoal-600 bg-charcoal-750 px-2 py-1 text-sm text-text-bright focus:border-charcoal-500 focus:outline-none"
          value={calendarMonth.date.getFullYear()}
          onChange={(e) => {
            const newDate = new Date(calendarMonth.date);
            newDate.setFullYear(parseInt(e.target.value));
            goToMonth(newDate);
          }}
        >
          {Array.from({ length: 100 }, (_, i) => {
            const year = new Date().getFullYear() - 50 + i;
            return (
              <option key={year} value={year}>
                {year}
              </option>
            );
          })}
        </select>
      </div>
      <button
        type="button"
        className={navButtonClass}
        disabled={!nextMonth}
        onClick={() => nextMonth && goToMonth(nextMonth)}
        aria-label="Go to next month"
      >
        <ChevronRightIcon className="size-4" />
      </button>
    </div>
  );
}

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      weekStartsOn={1}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-4",
        month_caption: "flex justify-center pt-1 relative items-center w-full",
        caption_label: "sr-only",
        nav: "hidden",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-text-dimmed rounded-md w-8 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-charcoal-700 [&:has([aria-selected].day-outside)]:bg-charcoal-700/50 [&:has([aria-selected].day-range-end)]:rounded-r-md first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md",
        day_button: cn(
          "size-8 p-0 font-normal text-text-bright rounded-md",
          "hover:bg-charcoal-700 hover:text-text-bright",
          "focus:bg-charcoal-700 focus:text-text-bright focus:outline-none",
          "aria-selected:opacity-100"
        ),
        range_start: "day-range-start rounded-l-md",
        range_end: "day-range-end rounded-r-md",
        selected:
          "bg-indigo-600 text-text-bright hover:bg-indigo-600 hover:text-text-bright focus:bg-indigo-600 focus:text-text-bright rounded-md",
        today: "bg-charcoal-700 text-text-bright rounded-md",
        outside:
          "day-outside text-text-dimmed opacity-50 aria-selected:bg-charcoal-700/50 aria-selected:text-text-dimmed aria-selected:opacity-30",
        disabled: "text-text-dimmed opacity-50",
        range_middle: "aria-selected:bg-charcoal-700 aria-selected:text-text-bright",
        hidden: "invisible",
        dropdowns: "flex gap-2 items-center justify-center",
        dropdown:
          "bg-charcoal-750 border border-charcoal-600 rounded px-2 py-1 text-sm text-text-bright focus:outline-none focus:border-charcoal-500",
        ...classNames,
      }}
      components={{
        MonthCaption: CustomMonthCaption,
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";
