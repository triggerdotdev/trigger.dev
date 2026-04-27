import { cn } from "~/utils/cn";

// Tree connector icons for sub-items. The SVG viewBox is 20x20 matching the size-5 icon area.
// Lines extend to y=-6 and y=26 to fill the full 32px row height (6px gap above/below the 20px icon).
export function TreeConnectorBranch({ className }: { className?: string }) {
  return (
    <svg
      className={cn("overflow-visible", className, "text-charcoal-600")}
      viewBox="0 0 20 20"
      fill="none"
    >
      <line x1="10" y1="-6" x2="10" y2="26" stroke="currentColor" strokeWidth="1" />
      <line x1="10" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function TreeConnectorEnd({ className }: { className?: string }) {
  return (
    <svg
      className={cn("overflow-visible", className, "text-charcoal-600")}
      viewBox="0 0 20 20"
      fill="none"
    >
      <line x1="10" y1="-6" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
      <line x1="10" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
