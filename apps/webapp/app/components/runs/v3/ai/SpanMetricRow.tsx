import type { ReactNode } from "react";

export function SpanMetricRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid h-7 grid-cols-[1fr_auto] items-center gap-4 rounded-sm px-1.5 transition odd:bg-charcoal-750/40 @[28rem]:grid-cols-[8rem_1fr] hover:bg-white/[0.04]">
      <span className="text-text-dimmed">{label}</span>
      <span className="text-right text-text-bright @[28rem]:text-left">{value}</span>
    </div>
  );
}
