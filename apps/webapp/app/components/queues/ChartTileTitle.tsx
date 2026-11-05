import type { ReactNode } from "react";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";

export function ChartTileTitle({
  label,
  description,
  peak,
  peakClassName,
  peakTooltip,
  legend,
  legendNode,
  titleAccessory,
  truncate = false,
}: {
  label: string;
  description?: ReactNode;
  peak: ReactNode;
  peakClassName?: string;
  peakTooltip?: ReactNode;
  legend?: Array<{ color: string; label: string }>;
  legendNode?: ReactNode;
  titleAccessory?: ReactNode;
  truncate?: boolean;
}) {
  const readout = (
    <span className={cn("text-xs font-normal tabular-nums text-text-dimmed", peakClassName)}>
      {peak}
    </span>
  );
  return (
    <span className={cn("flex flex-col gap-1", truncate && "min-w-0")}>
      <span className="flex items-baseline gap-2">
        <span className={cn("flex items-center gap-1", truncate && "min-w-0")}>
          {truncate ? (
            <SimpleTooltip
              button={
                <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {label}
                </span>
              }
              content={label}
              asChild
              disableHoverableContent
            />
          ) : (
            label
          )}
          {description ? (
            <span className="shrink-0">
              <InfoIconTooltip
                content={description}
                contentClassName="max-w-[230px]"
                disableHoverableContent
              />
            </span>
          ) : null}
        </span>
        {peak != null ? (
          peakTooltip ? (
            <SimpleTooltip
              button={readout}
              content={peakTooltip}
              className="max-w-[230px]"
              disableHoverableContent
            />
          ) : (
            readout
          )
        ) : null}
        {titleAccessory}
      </span>
      {legendNode ?? null}
      {legend ? (
        <span className="flex items-center gap-2">
          {legend.map((item) => (
            <span
              key={item.label}
              className="flex shrink-0 items-center gap-1 text-xs font-normal text-text-dimmed"
            >
              <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
