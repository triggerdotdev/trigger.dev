import { type ReactNode } from "react";

export function CodeGroup({ children }: { children: ReactNode }) {
  return <div className="rounded-sm border border-grid-bright bg-charcoal-850">{children}</div>;
}
