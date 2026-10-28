import { cn } from "~/utils/cn";

/** Stands in for a total while earlier days are still loading, so a partial sum never reads as final. */
export function UsagePlaceholder({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block h-[1em] w-16 animate-pulse rounded-sm bg-background-raised align-middle",
        className
      )}
    />
  );
}
