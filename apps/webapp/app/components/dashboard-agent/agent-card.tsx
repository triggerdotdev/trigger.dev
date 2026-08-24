// The transcript's card chrome. `ChatCardSlot` places a card; this owns the box,
// so stacked cards can't drift apart on border, surface or header inset.
import type { ReactNode } from "react";
import { cn } from "~/utils/cn";

const CARD_BOX = "overflow-hidden rounded-lg border border-border-bright bg-background-dimmed";

/** One header inset for every card, whatever its body density. */
const CARD_HEADER = "border-b border-grid-bright bg-background-bright px-3 py-2";

const CARD_BODY: Record<AgentCardDensity, string> = {
  compact: "space-y-4 px-3 py-3.5",
  roomy: "space-y-5 px-3 py-4",
};

/** How much air a card's body gives its sections. */
export type AgentCardDensity = "compact" | "roomy";

export function AgentCard({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(CARD_BOX, className)}>{children}</div>;
}

/** The card's top strip. `className` carries its own layout, never its inset. */
export function AgentCardHeader({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn(CARD_HEADER, className)}>{children}</div>;
}

export function AgentCardBody({
  density = "compact",
  className,
  children,
}: {
  density?: AgentCardDensity;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn(CARD_BODY[density], className)}>{children}</div>;
}
