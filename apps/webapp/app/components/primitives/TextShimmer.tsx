import { cn } from "~/utils/cn";

/**
 * A highlight travelling across the text, for "we're working on it" labels.
 *
 * CSS only: a wide gradient clipped to the glyphs and slid sideways. The technique needs
 * `color: transparent`, so the colours come from theme tokens rather than `currentColor`
 * — which would resolve to that transparent value.
 */
export function TextShimmer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "animate-text-shimmer bg-clip-text bg-[length:250%_100%] text-transparent",
        // A class, not an inline style: `motion-reduce:bg-none` below has to be
        // able to win, and an inline style outranks every class.
        "bg-[linear-gradient(90deg,var(--color-text-dimmed)_35%,var(--color-text-bright)_50%,var(--color-text-dimmed)_65%)]",
        // No motion: the highlight can't be seen moving, so drop the gradient
        // and leave plain dimmed text rather than a frozen bright patch.
        "motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-text-dimmed",
        className
      )}
    >
      {children}
    </span>
  );
}
