"use client";

import * as React from "react";
import { ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { format } from "date-fns";
import { Calendar } from "./Calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import { Button } from "./Buttons";
import { cn } from "~/utils/cn";
import { SimpleTooltip } from "./Tooltip";
import { XIcon } from "lucide-react";

type DateTimePickerProps = {
  label: string;
  value?: Date;
  onChange?: (date: Date | undefined) => void;
  showSeconds?: boolean;
  showNowButton?: boolean;
  showClearButton?: boolean;
  showInlineLabel?: boolean;
  className?: string;
};

export function DateTimePicker({
  label,
  value,
  onChange,
  showSeconds = true,
  showNowButton = false,
  showClearButton = false,
  showInlineLabel = false,
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
      {showInlineLabel && (
        <span className="w-6 shrink-0 text-right text-xxs text-charcoal-500">{label}</span>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex h-[1.8rem] w-full items-center justify-between gap-2 whitespace-nowrap rounded border border-charcoal-650 bg-charcoal-750 px-2 text-xs tabular-nums transition hover:border-charcoal-600",
              value ? "text-text-bright" : "text-text-dimmed"
            )}
          >
            {value ? format(value, "yyyy/MM/dd") : "Select date"}
            <ChevronUpDownIcon className="size-3.5 text-text-dimmed" />
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
          "h-[1.8rem] rounded border border-charcoal-650 bg-charcoal-750 px-2 text-xs tabular-nums transition hover:border-charcoal-600",
          value ? "text-text-bright" : "text-text-dimmed",
          "focus:border-charcoal-500 focus:outline-none",
          "[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
        )}
        aria-label={`${label} time`}
      />
      {showNowButton && (
        <Button
          type="button"
          variant="secondary/small"
          className="h-[1.8rem]"
          onClick={handleNowClick}
        >
          Now
        </Button>
      )}
      {showClearButton && (
        <SimpleTooltip
          button={
            <button
              type="button"
              className="flex h-[1.8rem] items-center justify-center px-1 text-text-dimmed transition hover:text-text-bright"
              onClick={handleClearClick}
            >
              <XIcon className="size-3.5" />
            </button>
          }
          content="Clear"
          disableHoverableContent
          asChild
        />
      )}
    </div>
  );
}
