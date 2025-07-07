import { Input } from "~/components/primitives/Input";
import { cn } from "~/utils/cn";
import React, { useRef, useState, useEffect } from "react";
import { Button } from "./Buttons";

export interface DurationPickerProps {
  id?: string; // used for the hidden input for form submission
  name?: string; // used for the hidden input for form submission
  defaultValueSeconds?: number;
  value?: number;
  onChange?: (totalSeconds: number) => void;
  variant?: "small" | "medium";
  showClearButton?: boolean;
}

export function DurationPicker({
  name,
  defaultValueSeconds: defaultValue = 0,
  value: controlledValue,
  onChange,
  variant = "small",
  showClearButton = true,
}: DurationPickerProps) {
  // Use controlled value if provided, otherwise use default
  const initialValue = controlledValue ?? defaultValue;

  const defaultHours = Math.floor(initialValue / 3600);
  const defaultMinutes = Math.floor((initialValue % 3600) / 60);
  const defaultSeconds = initialValue % 60;

  const [hours, setHours] = useState<number>(defaultHours);
  const [minutes, setMinutes] = useState<number>(defaultMinutes);
  const [seconds, setSeconds] = useState<number>(defaultSeconds);

  const minuteRef = useRef<HTMLInputElement>(null);
  const hourRef = useRef<HTMLInputElement>(null);
  const secondRef = useRef<HTMLInputElement>(null);

  const totalSeconds = hours * 3600 + minutes * 60 + seconds;

  const isEmpty = hours === 0 && minutes === 0 && seconds === 0;

  // Sync internal state with external value changes
  useEffect(() => {
    if (controlledValue !== undefined && controlledValue !== totalSeconds) {
      const newHours = Math.floor(controlledValue / 3600);
      const newMinutes = Math.floor((controlledValue % 3600) / 60);
      const newSeconds = controlledValue % 60;

      setHours(newHours);
      setMinutes(newMinutes);
      setSeconds(newSeconds);
    }
  }, [controlledValue]);

  useEffect(() => {
    onChange?.(totalSeconds);
  }, [totalSeconds, onChange]);

  const handleHoursChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value) || 0;
    setHours(Math.max(0, value));
  };

  const handleMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value) || 0;
    if (value >= 60) {
      setHours((prev) => prev + Math.floor(value / 60));
      setMinutes(value % 60);
      return;
    }

    setMinutes(Math.max(0, Math.min(59, value)));
  };

  const handleSecondsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value) || 0;
    if (value >= 60) {
      setMinutes((prev) => {
        const newMinutes = prev + Math.floor(value / 60);
        if (newMinutes >= 60) {
          setHours((prevHours) => prevHours + Math.floor(newMinutes / 60));
          return newMinutes % 60;
        }
        return newMinutes;
      });
      setSeconds(value % 60);
      return;
    }

    setSeconds(Math.max(0, Math.min(59, value)));
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    nextRef?: React.RefObject<HTMLInputElement>,
    prevRef?: React.RefObject<HTMLInputElement>
  ) => {
    if (e.key === "Tab") {
      return;
    }

    if (e.key === "ArrowRight" && nextRef) {
      e.preventDefault();
      nextRef.current?.focus();
      nextRef.current?.select();
      return;
    }

    if (e.key === "ArrowLeft" && prevRef) {
      e.preventDefault();
      prevRef.current?.focus();
      prevRef.current?.select();
      return;
    }
  };

  const clearDuration = () => {
    setHours(0);
    setMinutes(0);
    setSeconds(0);
    hourRef.current?.focus();
  };

  return (
    <div className="flex items-center gap-3">
      <input type="hidden" name={name} value={totalSeconds} />

      <div className="flex items-center gap-1">
        <div className="group flex items-center gap-1">
          <Input
            variant={variant}
            ref={hourRef}
            className={cn(
              "w-10 text-center font-mono tabular-nums caret-transparent [&::-webkit-inner-spin-button]:appearance-none",
              isEmpty && "text-text-dimmed"
            )}
            value={hours.toString()}
            onChange={handleHoursChange}
            onKeyDown={(e) => handleKeyDown(e, minuteRef)}
            onFocus={(e) => e.target.select()}
            type="number"
            min={0}
            inputMode="numeric"
          />
          <span className="text-sm text-text-dimmed transition-colors duration-200 group-focus-within:text-text-bright/80">
            h
          </span>
        </div>
        <div className="group flex items-center gap-1">
          <Input
            variant={variant}
            ref={minuteRef}
            className={cn(
              "w-10 text-center font-mono tabular-nums caret-transparent [&::-webkit-inner-spin-button]:appearance-none",
              isEmpty && "text-text-dimmed"
            )}
            value={minutes.toString()}
            onChange={handleMinutesChange}
            onKeyDown={(e) => handleKeyDown(e, secondRef, hourRef)}
            onFocus={(e) => e.target.select()}
            type="number"
            min={0}
            max={59}
            inputMode="numeric"
          />
          <span className="text-sm text-text-dimmed transition-colors duration-200 group-focus-within:text-text-bright/80">
            m
          </span>
        </div>
        <div className="group flex items-center gap-1">
          <Input
            variant={variant}
            ref={secondRef}
            className={cn(
              "w-10 text-center font-mono tabular-nums caret-transparent [&::-webkit-inner-spin-button]:appearance-none",
              isEmpty && "text-text-dimmed"
            )}
            value={seconds.toString()}
            onChange={handleSecondsChange}
            onKeyDown={(e) => handleKeyDown(e, undefined, minuteRef)}
            onFocus={(e) => e.target.select()}
            type="number"
            min={0}
            max={59}
            inputMode="numeric"
          />
          <span className="text-sm text-text-dimmed transition-colors duration-200 group-focus-within:text-text-bright/80">
            s
          </span>
        </div>
      </div>

      {showClearButton && (
        <Button type="button" variant={`tertiary/${variant}`} onClick={clearDuration}>
          Clear
        </Button>
      )}
    </div>
  );
}
