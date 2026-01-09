"use client";

import * as React from "react";
import { ChevronDownIcon } from "@heroicons/react/20/solid";
import { format } from "date-fns";
import { Calendar } from "./Calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import { Button } from "./Buttons";
import { cn } from "~/utils/cn";

type DateTimePickerProps = {
  label: string;
  value?: Date;
  onChange?: (date: Date | undefined) => void;
  showSeconds?: boolean;
  showNowButton?: boolean;
  showClearButton?: boolean;
  className?: string;
};

export function DateTimePicker({
  label,
  value,
  onChange,
  showSeconds = true,
  showNowButton = false,
  showClearButton = false,
  className,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false);

  // Extract time parts from value
  const hours = value ? value.getHours().toString().padStart(2, "0") : "";
  const minutes = value ? value.getMinutes().toString().padStart(2, "0") : "";
  const seconds = value ? value.getSeconds().toString().padStart(2, "0") : "";
  const timeValue = showSeconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`;

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      // Preserve the time from the current value if it exists
      if (value) {
        date.setHours(value.getHours());
        date.setMinutes(value.getMinutes());
        date.setSeconds(value.getSeconds());
      }
      onChange?.(date);
    } else {
      onChange?.(undefined);
    }
    setOpen(false);
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const timeString = e.target.value;
    if (!timeString) return;

    const [h, m, s] = timeString.split(":").map(Number);
    const newDate = value ? new Date(value) : new Date();
    newDate.setHours(h || 0);
    newDate.setMinutes(m || 0);
    newDate.setSeconds(s || 0);
    onChange?.(newDate);
  };

  const handleNowClick = () => {
    onChange?.(new Date());
  };

  const handleClearClick = () => {
    onChange?.(undefined);
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex h-6 items-center justify-between gap-2 rounded border border-charcoal-600 bg-charcoal-750 px-2 text-xs tabular-nums transition hover:border-charcoal-500",
              value ? "text-text-bright" : "text-text-dimmed"
            )}
          >
            {value ? format(value, "yyyy/MM/dd") : "Select date"}
            <ChevronDownIcon className="size-4 text-text-dimmed" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={handleDateSelect}
            captionLayout="dropdown"
          />
        </PopoverContent>
      </Popover>
      <input
        type="time"
        step={showSeconds ? "1" : "60"}
        value={value ? timeValue : ""}
        onChange={handleTimeChange}
        className={cn(
          "h-6 rounded border border-charcoal-600 bg-charcoal-750 px-2 text-xs tabular-nums transition hover:border-charcoal-500",
          "text-text-bright placeholder:text-text-dimmed",
          "focus:border-charcoal-500 focus:outline-none",
          "[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
        )}
        aria-label={`${label} time`}
      />
      {showNowButton && (
        <Button type="button" variant="tertiary/small" onClick={handleNowClick}>
          Now
        </Button>
      )}
      {showClearButton && (
        <Button type="button" variant="tertiary/small" onClick={handleClearClick}>
          Clear
        </Button>
      )}
    </div>
  );
}
