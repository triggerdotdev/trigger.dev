import { ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { addDays, format } from "date-fns";
import { useState } from "react";
import { ButtonContent } from "~/components/primitives/Buttons";
import { Calendar } from "~/components/primitives/Calendar";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { apiKeyExpiryDay, isApiKeyExpiryDayExpired } from "~/utils/apiKeyExpiry";
import { cn } from "~/utils/cn";

export type ExpiryPreset = { value: string; label: string; days: number };

/**
 * Picks the UTC day a credential expires at the end of: a preset, a calendar day, or (with
 * `allowNever`) no expiry. With `maxDays`, days further than that from today can't be picked.
 */
export function ExpiryDatePicker({
  id,
  presets,
  allowNever = false,
  maxDays,
  expiration,
  date,
  onChange,
}: {
  id: string;
  presets: ExpiryPreset[];
  allowNever?: boolean;
  maxDays?: number;
  expiration: string;
  date: Date | undefined;
  onChange: (expiration: string, date: Date | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState(() => apiKeyExpiryDay());
  const [month, setMonth] = useState(date ?? today);
  const lastDay = maxDays === undefined ? undefined : addDays(today, maxDays);
  const isUnavailable = (day: Date) =>
    isApiKeyExpiryDayExpired(day) || (lastDay !== undefined && day > lastDay);
  const label =
    expiration === "never"
      ? "Never"
      : (presets.find((preset) => preset.value === expiration)?.label ?? "Custom date");

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          const currentDay = apiKeyExpiryDay();
          setToday(currentDay);
          setMonth(date && date >= currentDay ? date : currentDay);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          className="group/button w-full cursor-pointer outline-hidden focus-custom"
        >
          <ButtonContent
            variant="secondary/medium"
            TrailingIcon={ChevronUpDownIcon}
            fullWidth
            textAlignLeft
          >
            <span className="flex w-full items-center justify-between gap-3">
              <span>{label}</span>
              {date ? (
                <span className="text-xs text-text-faint">{format(date, "d MMM yyyy")}</span>
              ) : null}
            </span>
          </ButtonContent>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto min-w-0 overflow-y-auto p-0" align="end">
        <div className="flex flex-col sm:flex-row">
          <div className="space-y-1 border-b border-grid-bright p-2 sm:min-w-56 sm:border-b-0 sm:border-r">
            {presets.map((preset) => {
              const presetDate = addDays(today, preset.days);
              return (
                <button
                  key={preset.value}
                  type="button"
                  aria-pressed={expiration === preset.value}
                  className={cn(
                    "flex w-full cursor-pointer items-center justify-between gap-4 rounded-sm px-3 py-2 text-left text-sm text-text-bright hover:bg-tertiary focus-custom",
                    expiration === preset.value && "bg-tertiary"
                  )}
                  onClick={() => {
                    const currentDay = apiKeyExpiryDay();
                    const selectedDate = addDays(currentDay, preset.days);
                    setToday(currentDay);
                    onChange(preset.value, selectedDate);
                    setMonth(selectedDate);
                  }}
                >
                  <span>{preset.label}</span>
                  <span className="text-xs text-text-faint">
                    {format(presetDate, "d MMM yyyy")}
                  </span>
                </button>
              );
            })}
            {allowNever ? (
              <div className="mt-2 border-t border-grid-bright pt-2">
                <button
                  type="button"
                  aria-pressed={expiration === "never"}
                  className={cn(
                    "w-full cursor-pointer rounded-sm px-3 py-2 text-left text-sm text-text-bright hover:bg-tertiary focus-custom",
                    expiration === "never" && "bg-tertiary"
                  )}
                  onClick={() => {
                    onChange("never", undefined);
                    setOpen(false);
                  }}
                >
                  Never
                </button>
              </div>
            ) : null}
          </div>
          <Calendar
            mode="single"
            required
            selected={date}
            today={today}
            month={month}
            endMonth={lastDay}
            onMonthChange={setMonth}
            disabled={isUnavailable}
            onSelect={(selectedDate) => {
              if (isUnavailable(selectedDate)) {
                setToday(apiKeyExpiryDay());
                return;
              }
              onChange("custom", selectedDate);
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
