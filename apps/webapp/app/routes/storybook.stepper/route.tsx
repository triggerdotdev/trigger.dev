import { MinusIcon, PlusIcon } from "@heroicons/react/20/solid";
import { useState, useRef, type ChangeEvent } from "react";
import { Header2 } from "~/components/primitives/Headers";
import { cn } from "~/utils/cn";

export default function Story() {
  const [value1, setValue1] = useState<number | "">(0);
  const [value2, setValue2] = useState<number | "">(100);
  const [value3, setValue3] = useState<number | "">(0);
  const [value4, setValue4] = useState<number | "">(250);

  return (
    <div className="grid h-full w-full place-items-center">
      <div className="flex flex-col gap-4">
        <Header2>InputStepper</Header2>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-dimmed">Size: base (default), Step: 75</label>
          <InputStepper
            value={value1}
            onChange={(e) => setValue1(e.target.value === "" ? "" : Number(e.target.value))}
            step={75}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-dimmed">
            Size: base (default), Step: 50, Min: 0, Max: 1000
          </label>
          <InputStepper
            value={value2}
            onChange={(e) => setValue2(e.target.value === "" ? "" : Number(e.target.value))}
            step={50}
            min={0}
            max={1000}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-dimmed">Size: large, Step: 50</label>
          <InputStepper
            value={value4}
            onChange={(e) => setValue4(e.target.value === "" ? "" : Number(e.target.value))}
            step={50}
            controlSize="large"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-text-dimmed">Disabled state</label>
          <InputStepper
            value={value3}
            onChange={(e) => setValue3(e.target.value === "" ? "" : Number(e.target.value))}
            step={50}
            disabled
          />
        </div>
      </div>
    </div>
  );
}

type InputStepperProps = JSX.IntrinsicElements["input"] & {
  step?: number;
  min?: number;
  max?: number;
  round?: boolean;
  controlSize?: "base" | "large";
};

function InputStepper({
  value,
  onChange,
  step = 50,
  min,
  max,
  round = true,
  controlSize = "base",
  name,
  id,
  disabled = false,
  readOnly = false,
  className,
  placeholder = "Type a number",
}: InputStepperProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStepUp = () => {
    if (!inputRef.current || disabled) return;

    // If rounding is enabled, ensure we start from a rounded base before stepping
    if (round) {
      // If field is empty, treat as 0 (or min if provided) before stepping up
      if (inputRef.current.value === "") {
        inputRef.current.value = String(min ?? 0);
      } else {
        commitRoundedFromInput();
      }
    }
    inputRef.current.stepUp();
    const event = new Event("change", { bubbles: true });
    inputRef.current.dispatchEvent(event);
  };

  const handleStepDown = () => {
    if (!inputRef.current || disabled) return;

    // If rounding is enabled, ensure we start from a rounded base before stepping
    if (round) {
      // If field is empty, treat as 0 (or min if provided) before stepping down
      if (inputRef.current.value === "") {
        inputRef.current.value = String(min ?? 0);
      } else {
        commitRoundedFromInput();
      }
    }
    inputRef.current.stepDown();
    const event = new Event("change", { bubbles: true });
    inputRef.current.dispatchEvent(event);
  };

  const numericValue = value === "" ? NaN : (value as number);
  const isMinDisabled = min !== undefined && !Number.isNaN(numericValue) && numericValue <= min;
  const isMaxDisabled = max !== undefined && !Number.isNaN(numericValue) && numericValue >= max;

  function clamp(val: number): number {
    if (Number.isNaN(val)) return typeof value === "number" ? value : min ?? 0;
    let next = val;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  }

  function roundToStep(val: number): number {
    if (step <= 0) return val;
    const base = min ?? 0;
    const shifted = val - base;
    const quotient = shifted / step;
    const floored = Math.floor(quotient);
    const ceiled = Math.ceil(quotient);
    const down = base + floored * step;
    const up = base + ceiled * step;
    const distDown = Math.abs(val - down);
    const distUp = Math.abs(up - val);
    return distUp < distDown ? up : down;
  }

  function commitRoundedFromInput() {
    if (!inputRef.current || disabled || readOnly) return;
    const el = inputRef.current;
    const raw = el.value;
    if (raw === "") return; // do not coerce empty to 0; keep placeholder visible
    const numeric = Number(raw);
    if (Number.isNaN(numeric)) return; // ignore non-numeric
    const rounded = clamp(roundToStep(numeric));
    if (String(rounded) === String(value)) return;
    // Update the real input's value for immediate UI feedback
    el.value = String(rounded);
    // Invoke consumer onChange with the real element as target/currentTarget
    onChange?.({
      target: el,
      currentTarget: el,
    } as unknown as ChangeEvent<HTMLInputElement>);
  }

  const sizeStyles = {
    base: {
      container: "h-9",
      input: "text-sm px-3",
      button: "size-6",
      icon: "size-3.5",
      gap: "gap-1 pr-1.5",
    },
    large: {
      container: "h-11 rounded-md",
      input: "text-base px-3.5",
      button: "size-8",
      icon: "size-5",
      gap: "gap-1.5 pr-[0.3125rem]",
    },
  } as const;

  const size = sizeStyles[controlSize];

  return (
    <div
      className={cn(
        "flex items-center rounded border border-charcoal-600 bg-tertiary transition hover:border-charcoal-550/80 hover:bg-charcoal-600/80",
        size.container,
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
        placeholder={placeholder}
        onChange={(e) => {
          // Allow empty string to pass through so user can clear the field
          if (e.currentTarget.value === "") {
            // reflect emptiness in the input and notify consumer as empty
            if (inputRef.current) inputRef.current.value = "";
            onChange?.({
              target: e.currentTarget,
              currentTarget: e.currentTarget,
            } as ChangeEvent<HTMLInputElement>);
            return;
          }
          onChange?.(e);
        }}
        onBlur={(e) => {
          // If blur is caused by clicking our step buttons, we prevent pointerdown
          // so blur shouldn't fire. This is for safety in case of keyboard focus move.
          if (round) commitRoundedFromInput();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && round) {
            e.preventDefault();
            commitRoundedFromInput();
          }
        }}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        readOnly={readOnly}
        className={cn(
          "placeholder:text-muted-foreground h-full grow border-0 bg-transparent text-left text-text-bright outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 disabled:cursor-not-allowed",
          size.input,
          // Hide number input arrows
          "[type=number]:border-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        )}
      />

      <div className={cn("flex items-center", size.gap)}>
        <button
          type="button"
          onClick={handleStepDown}
          onPointerDown={(e) => e.preventDefault()}
          disabled={disabled || isMinDisabled}
          aria-label={`Decrease by ${step}`}
          className={cn(
            "flex items-center justify-center rounded border border-error/30 bg-error/20 transition",
            size.button,
            "hover:border-error/50 hover:bg-error/30",
            "disabled:cursor-not-allowed disabled:opacity-40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-link"
          )}
        >
          <MinusIcon className={cn("text-error", size.icon)} />
        </button>

        <button
          type="button"
          onClick={handleStepUp}
          onPointerDown={(e) => e.preventDefault()}
          disabled={disabled || isMaxDisabled}
          aria-label={`Increase by ${step}`}
          className={cn(
            "flex items-center justify-center rounded border border-success/30 bg-success/10 transition",
            size.button,
            "hover:border-success/40 hover:bg-success/20",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-link"
          )}
        >
          <PlusIcon className={cn("text-success", size.icon)} />
        </button>
      </div>
    </div>
  );
}
