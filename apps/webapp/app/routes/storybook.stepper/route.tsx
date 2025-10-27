import { MinusIcon, PlusIcon } from "@heroicons/react/20/solid";
import { useState, useRef, type ChangeEvent } from "react";
import { Header2 } from "~/components/primitives/Headers";
import { cn } from "~/utils/cn";

export default function Story() {
  const [value1, setValue1] = useState(0);
  const [value2, setValue2] = useState(100);
  const [value3, setValue3] = useState(0);

  return (
    <div className="grid h-full w-full place-items-center">
      <div className="flex flex-col gap-4">
        <Header2>InputStepper</Header2>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-dimmed">Size: base (default), Step: 75</label>
          <InputStepper
            value={value1}
            onChange={(e) => setValue1(Number(e.target.value))}
            step={75}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-dimmed">
            Size: base (default), Step: 50, Max: 1000
          </label>
          <InputStepper
            value={value2}
            onChange={(e) => setValue2(Number(e.target.value))}
            step={50}
            max={1000}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-dimmed">Disabled state</label>
          <InputStepper
            value={value3}
            onChange={(e) => setValue3(Number(e.target.value))}
            step={50}
            disabled
          />
        </div>
      </div>
    </div>
  );
}

interface InputStepperProps {
  value: number;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  step?: number;
  min?: number;
  max?: number;
  name?: string;
  id?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
}

function InputStepper({
  value,
  onChange,
  step = 50,
  min,
  max,
  name,
  id,
  disabled = false,
  readOnly = false,
  className,
}: InputStepperProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStepUp = () => {
    if (!inputRef.current || disabled) return;

    inputRef.current.stepUp();

    // Dispatch a native change event so the onChange handler is called
    const event = new Event("change", { bubbles: true });
    inputRef.current.dispatchEvent(event);
  };

  const handleStepDown = () => {
    if (!inputRef.current || disabled) return;

    inputRef.current.stepDown();

    // Dispatch a native change event so the onChange handler is called
    const event = new Event("change", { bubbles: true });
    inputRef.current.dispatchEvent(event);
  };

  const isMinDisabled = min !== undefined && value <= min;
  const isMaxDisabled = max !== undefined && value >= max;

  return (
    <div
      className={cn(
        "flex h-9 items-center rounded border border-charcoal-600 bg-tertiary transition hover:border-charcoal-550/80 hover:bg-charcoal-600/80",
        "has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-0 has-[:focus-visible]:outline-text-link",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      <input
        ref={inputRef}
        type="number"
        id={id}
        name={name}
        value={value}
        onChange={onChange}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        readOnly={readOnly}
        className={cn(
          "placeholder:text-muted-foreground h-full grow border-0 bg-transparent px-3 text-left text-sm text-text-bright outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 disabled:cursor-not-allowed",
          // Hide number input arrows
          "[type=number]:border-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        )}
      />

      <div className="flex items-center gap-1 pr-1.5">
        {/* Minus Button */}
        <button
          type="button"
          onClick={handleStepDown}
          disabled={disabled || isMinDisabled}
          aria-label={`Decrease by ${step}`}
          className={cn(
            "flex size-6 items-center justify-center rounded border border-error/30 bg-error/20 transition",
            "hover:border-error/50 hover:bg-error/30",
            "disabled:cursor-not-allowed disabled:opacity-40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-link"
          )}
        >
          <MinusIcon className="h-3.5 w-3.5 text-error" />
        </button>

        <button
          type="button"
          onClick={handleStepUp}
          disabled={disabled || isMaxDisabled}
          aria-label={`Increase by ${step}`}
          className={cn(
            "flex size-6 items-center justify-center rounded border border-success/30 bg-success/10 transition",
            "hover:border-success/40 hover:bg-success/20",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-link"
          )}
        >
          <PlusIcon className="h-3.5 w-3.5 text-success" />
        </button>
      </div>
    </div>
  );
}
