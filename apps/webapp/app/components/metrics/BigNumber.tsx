import { type ReactNode } from "react";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { Spinner } from "../primitives/Spinner";
import { cn } from "~/utils/cn";

interface BigNumberProps {
  title: ReactNode;
  animate?: boolean;
  loading?: boolean;
  value?: number;
  valueClassName?: string;
  defaultValue?: number;
  accessory?: ReactNode;
  suffix?: string;
  suffixClassName?: string;
}

export function BigNumber({
  title,
  value,
  defaultValue,
  valueClassName,
  suffix,
  suffixClassName,
  accessory,
  animate = false,
  loading = false,
}: BigNumberProps) {
  const v = value ?? defaultValue;
  return (
    <div className="grid grid-rows-[1.5rem_auto] gap-4 rounded-sm border border-grid-dimmed bg-background-bright p-4">
      <div className="flex items-center justify-between">
        <div className="text-2sm text-text-dimmed">{title}</div>
        {accessory && <div className="flex-shrink-0">{accessory}</div>}
      </div>
      <div
        className={cn(
          "h-[3.75rem] text-[3.75rem] font-normal tabular-nums leading-none text-text-bright",
          valueClassName
        )}
      >
        {loading ? (
          <Spinner className="size-6" />
        ) : v !== undefined ? (
          <div className="flex items-baseline gap-1">
            {animate ? <AnimatedNumber value={v} /> : v}
            {suffix && <div className={cn("text-xs", suffixClassName)}>{suffix}</div>}
          </div>
        ) : (
          "–"
        )}
      </div>
    </div>
  );
}
