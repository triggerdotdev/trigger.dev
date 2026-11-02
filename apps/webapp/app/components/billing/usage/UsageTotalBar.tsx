import { usageBarScale } from "~/utils/billingUsageChart";
import { cn } from "~/utils/cn";

const LABEL_FLIP_PERCENT = 70;

export function UsageTotalBar({
  used,
  included,
  limit,
  format,
}: {
  used: number;
  included?: number;
  limit?: number;
  format: (amount: number) => string;
}) {
  const scale = usageBarScale(used, included, limit);

  return (
    <div className="relative mt-7 h-3 w-full rounded-sm bg-background-raised">
      <div
        className="absolute inset-y-0 left-0 rounded-sm bg-indigo-500"
        style={{ width: `${scale.used}%` }}
      />
      {included !== undefined && scale.included !== undefined && (
        <UsageBarMarker percent={scale.included} label={`Included usage ${format(included)}`} />
      )}
      {limit !== undefined && scale.limit !== undefined && (
        <UsageBarMarker percent={scale.limit} label={`Billing limit ${format(limit)}`} isLimit />
      )}
    </div>
  );
}

function UsageBarMarker({
  percent,
  label,
  isLimit = false,
}: {
  percent: number;
  label: string;
  isLimit?: boolean;
}) {
  const labelOnLeft = isLimit || percent > LABEL_FLIP_PERCENT;

  return (
    <div
      className={cn(
        "absolute -bottom-1 -top-[22px] w-0 border-l border-dashed",
        isLimit ? "border-warning" : "border-text-dimmed"
      )}
      style={{ left: `${percent}%` }}
    >
      <span
        className={cn(
          "absolute top-0 whitespace-nowrap text-xs",
          labelOnLeft ? "right-1" : "left-1",
          isLimit ? "text-warning" : "text-text-dimmed"
        )}
      >
        {label}
      </span>
    </div>
  );
}
