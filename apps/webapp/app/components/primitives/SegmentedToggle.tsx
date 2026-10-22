import { motion } from "framer-motion";
import { useId, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "~/utils/cn";

export type SegmentedToggleSegment<T extends string> = {
  value: T;
  label: string;
  icon: ReactNode;
  ariaLabel?: string;
};

type SegmentedToggleProps<T extends string> = {
  segments: SegmentedToggleSegment<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "small" | "medium";
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
};

const SIZES = {
  small: { group: "h-6 text-xs", segment: "h-5 px-1.5" },
  medium: { group: "h-8 text-sm", segment: "h-6 px-2" },
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => Boolean(window.matchMedia?.(REDUCED_MOTION_QUERY).matches),
    () => false
  );
}

const SECONDS = 0.2;

export function SegmentedToggle<T extends string>({
  segments,
  value,
  onChange,
  size = "small",
  disabled,
  ariaLabel,
  className,
}: SegmentedToggleProps<T>) {
  const reduced = usePrefersReducedMotion();
  const pillId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const duration = reduced ? 0 : SECONDS;
  const sizes = SIZES[size];

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + segments.length) % segments.length;
    onChange(segments[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-motion={reduced ? "reduced" : "full"}
      data-duration={duration}
      className={cn(
        "inline-flex items-center rounded-full border border-grid-bright p-0.5",
        sizes.group,
        disabled && "pointer-events-none opacity-60",
        className
      )}
    >
      {segments.map((segment, index) => {
        const active = segment.value === value;
        return (
          <button
            key={segment.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={segment.ariaLabel ?? segment.label}
            title={active ? undefined : segment.label}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange(segment.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative flex items-center rounded-full focus-custom",
              sizes.segment,
              active ? "text-text-bright" : "text-text-dimmed hover:text-text-bright"
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                transition={{ duration, ease: "easeInOut" }}
                className="absolute inset-0 rounded-full bg-background-raised"
              />
            )}
            <span className="relative flex">{segment.icon}</span>
            {active && (
              <span data-toggle-label className="relative whitespace-nowrap pl-1.5">
                {segment.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
