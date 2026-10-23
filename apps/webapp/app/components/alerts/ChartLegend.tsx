import { cn } from "~/utils/cn";

export const THRESHOLD_LINE_COLOR = "var(--color-border-brighter)";
export const WARNING_COLOR = "var(--color-warning)";

export type ChartLegendItem = {
  swatch: "line" | "dashed" | "area" | "marker";
  color: string;
  label: string;
};

export const warningLegendItem = (
  label: string,
  swatch: ChartLegendItem["swatch"] = "line"
): ChartLegendItem => ({ swatch, color: WARNING_COLOR, label });

function Swatch({ swatch, color }: Pick<ChartLegendItem, "swatch" | "color">) {
  if (swatch === "line") {
    return <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: color }} />;
  }
  if (swatch === "dashed") {
    return <span className="w-3 border-t-2 border-dashed" style={{ borderColor: color }} />;
  }
  if (swatch === "marker") {
    return (
      <span className="text-[8px] leading-none" style={{ color }}>
        ▲
      </span>
    );
  }
  return <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: color }} />;
}

export function ChartLegend({
  items,
  className,
}: {
  items: ChartLegendItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {items.map((item) => (
        <span
          key={`${item.swatch}-${item.label}`}
          className="flex items-center gap-1 text-xs font-normal text-text-dimmed"
        >
          <Swatch swatch={item.swatch} color={item.color} />
          {item.label}
        </span>
      ))}
    </span>
  );
}
