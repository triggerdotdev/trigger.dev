import { type ReactNode } from "react";
import { cn } from "~/utils/cn";
import { formatNumber, formatNumberCompact } from "~/utils/numberFormatter";
import { Header3 } from "../primitives/Headers";
import { Spinner } from "../primitives/Spinner";
import { SimpleTooltip } from "../primitives/Tooltip";
import { AnimatedNumber } from "../primitives/AnimatedNumber";

interface BigNumberProps {
  title: ReactNode;
  animate?: boolean;
  loading?: boolean;
  value?: number;
  /** Pre-formatted display value; overrides the numeric `value` rendering when set. */
  formattedValue?: ReactNode;
  valueClassName?: string;
  defaultValue?: number;
  accessory?: ReactNode;
  suffix?: ReactNode;
  suffixClassName?: string;
  compactThreshold?: number;
}

export function BigNumber({
  title,
  value,
  formattedValue,
  defaultValue,
  valueClassName,
  suffix,
  suffixClassName,
  accessory,
  animate = false,
  loading = false,
  compactThreshold,
}: BigNumberProps) {
  const v = value ?? defaultValue;

  const shouldCompact =
    typeof compactThreshold === "number" && v !== undefined && v >= compactThreshold;

  return (
    <div className="group flex flex-col justify-between gap-4 rounded-lg border border-grid-bright bg-background-bright pb-4 pl-4 pr-3 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Header3 className="leading-6">{title}</Header3>
        {accessory && <div className="shrink-0">{accessory}</div>}
      </div>
      <div
        className={cn(
          "text-[3.75rem] font-normal tabular-nums leading-none text-text-bright",
          valueClassName
        )}
      >
        {loading ? (
          <Spinner className="size-6" />
        ) : formattedValue !== undefined ? (
          <div className="flex flex-wrap items-baseline gap-2">
            {formattedValue}
            {suffix && <div className={cn("text-xs tabular-nums", suffixClassName)}>{suffix}</div>}
          </div>
        ) : v !== undefined ? (
          <div className="flex flex-wrap items-baseline gap-2">
            {shouldCompact ? (
              <SimpleTooltip
                button={animate ? <AnimatedNumber value={v} /> : formatNumberCompact(v)}
                content={formatNumber(v)}
              />
            ) : animate ? (
              <AnimatedNumber value={v} />
            ) : (
              formatNumber(v)
            )}
            {suffix && <div className={cn("text-xs tabular-nums", suffixClassName)}>{suffix}</div>}
          </div>
        ) : (
          "–"
        )}
      </div>
    </div>
  );
}
