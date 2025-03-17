import { type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { Spinner } from "../primitives/Spinner";

interface BigNumberProps {
  title: ReactNode;
  animate?: boolean;
  loading?: boolean;
  value?: number;
  defaultValue?: number;
  accessory?: ReactNode;
}

export function BigNumber({
  title,
  value,
  defaultValue,
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
      <div className="h-[3.75rem] text-[3.75rem] font-normal tabular-nums leading-none text-text-bright">
        {loading ? (
          <Spinner className="size-6" />
        ) : v !== undefined ? (
          animate ? (
            <AnimatedNumber value={v} />
          ) : (
            v
          )
        ) : (
          "–"
        )}
      </div>
    </div>
  );
}
