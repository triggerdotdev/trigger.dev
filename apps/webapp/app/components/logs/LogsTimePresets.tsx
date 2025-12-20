import { Button } from "~/components/primitives/Buttons";
import { useSearchParams } from "~/hooks/useSearchParam";
import { cn } from "~/utils/cn";

// Quick preset periods for common log viewing use cases
const quickPeriods = [
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "1h", value: "1h" },
  { label: "24h", value: "1d" },
  { label: "7d", value: "7d" },
] as const;

export function LogsTimePresets() {
  const { value, replace } = useSearchParams();
  const currentPeriod = value("period");
  const hasCustomRange = value("from") || value("to");

  // Don't show presets if custom range is active
  if (hasCustomRange) {
    return null;
  }

  const handlePeriodClick = (period: string) => {
    replace({
      period,
      cursor: undefined,
      direction: undefined,
      from: undefined,
      to: undefined,
    });
  };

  return (
    <div className="flex items-center gap-1">
      {quickPeriods.map((p) => (
        <Button
          key={p.value}
          variant="tertiary/small"
          className={cn(
            "min-w-[3rem] text-xs",
            currentPeriod === p.value && "bg-charcoal-700 text-text-bright"
          )}
          onClick={(e) => {
            e.preventDefault();
            handlePeriodClick(p.value);
          }}
          type="button"
        >
          {p.label}
        </Button>
      ))}
    </div>
  );
}
