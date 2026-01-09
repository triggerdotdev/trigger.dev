"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { DayPicker } from "react-day-picker";
import { cn } from "~/utils/cn";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-4",
        month_caption: "flex justify-center pt-1 relative items-center w-full",
        caption_label: "text-sm font-medium text-text-bright",
        nav: "flex items-center gap-1",
        button_previous:
          "absolute left-1 top-0 size-7 bg-transparent p-0 text-text-dimmed hover:text-text-bright transition-colors flex items-center justify-center",
        button_next:
          "absolute right-1 top-0 size-7 bg-transparent p-0 text-text-dimmed hover:text-text-bright transition-colors flex items-center justify-center",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-text-dimmed rounded-md w-8 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-charcoal-700 [&:has([aria-selected].day-outside)]:bg-charcoal-700/50 [&:has([aria-selected].day-range-end)]:rounded-r-md first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md",
        day_button: cn(
          "size-8 p-0 font-normal text-text-bright",
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
        Chevron: ({ orientation }) => {
          if (orientation === "left") {
            return <ChevronLeftIcon className="size-4" />;
          }
          return <ChevronRightIcon className="size-4" />;
        },
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
