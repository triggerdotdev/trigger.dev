import type { ReactNode } from "react";

export function DetailChartBlock({
  toolbar,
  children,
}: {
  toolbar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="detail-chart-block"
      className="flex flex-col gap-3 overflow-hidden border-b border-grid-bright bg-background-bright py-2 pl-2 pr-4"
    >
      <div className="flex items-center gap-2">{toolbar}</div>
      {children}
    </div>
  );
}
