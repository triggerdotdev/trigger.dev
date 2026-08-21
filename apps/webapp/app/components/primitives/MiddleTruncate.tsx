import { useRef, useState, useLayoutEffect, useCallback } from "react";
import { cn } from "~/utils/cn";
import { SimpleTooltip } from "./Tooltip";

type MiddleTruncateProps = {
  text: string;
  className?: string;
  /** Hover delay before the full-text tooltip opens. Defaults to the tooltip default (0). */
  tooltipDelay?: number;
  /** Merged onto the tooltip body, for callers whose text needs a bigger or scrollable box. */
  tooltipContentClassName?: string;
  /**
   * Roughly how many characters fit, used only for the very first render. Truncation needs
   * layout, so the server (and the pre-hydration client) can only render the full string --
   * long values visibly snapped shorter once React hydrated. Seeding from a character count
   * is deterministic, so it matches on both sides and the measured pass just refines it.
   */
  initialCharBudget?: number;
};

/** Deterministic, layout-free middle truncation used to seed the first render. */
function seedTruncation(text: string, budget: number | undefined): string {
  if (budget === undefined || text.length <= budget) return text;
  const keep = Math.max(1, Math.floor((budget - 1) / 2));
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

/**
 * A component that truncates text in the middle, showing the beginning and end.
 * Shows the full text in a tooltip on hover when truncated.
 *
 * Example: "namespace:category:subcategory:task-name" becomes "namespace:cat…task-name"
 */
export function MiddleTruncate({
  text,
  className,
  tooltipDelay,
  tooltipContentClassName,
  initialCharBudget,
}: MiddleTruncateProps) {
  const seed = seedTruncation(text, initialCharBudget);
  const containerRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [displayText, setDisplayText] = useState(seed);
  const [isTruncated, setIsTruncated] = useState(seed !== text);

  const calculateTruncation = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const parent = container.parentElement;
    if (!parent) return;

    // Get the available width from the parent container
    const parentStyle = getComputedStyle(parent);
    const availableWidth =
      parent.clientWidth -
      parseFloat(parentStyle.paddingLeft) -
      parseFloat(parentStyle.paddingRight);

    // Measure full text width
    measure.textContent = text;
    const fullTextWidth = measure.offsetWidth;

    // If text fits, no truncation needed
    if (fullTextWidth <= availableWidth) {
      setDisplayText(text);
      setIsTruncated(false);
      return;
    }

    // Text needs truncation - find optimal split
    const ellipsis = "…";
    measure.textContent = ellipsis;
    const ellipsisWidth = measure.offsetWidth;

    const targetWidth = availableWidth - ellipsisWidth - 4; // small buffer

    if (targetWidth <= 0) {
      setDisplayText(ellipsis);
      setIsTruncated(true);
      return;
    }

    // Incrementally find the optimal character counts
    let startChars = 0;
    let endChars = 0;

    // Alternate adding characters from start and end
    while (startChars + endChars < text.length) {
      // Try adding to start
      const testStart = text.slice(0, startChars + 1);
      const testEnd = endChars > 0 ? text.slice(-endChars) : "";
      measure.textContent = testStart + ellipsis + testEnd;

      if (measure.offsetWidth > targetWidth) break;
      startChars++;

      if (startChars + endChars >= text.length) break;

      // Try adding to end
      const newTestEnd = text.slice(-(endChars + 1));
      measure.textContent = text.slice(0, startChars) + ellipsis + newTestEnd;

      if (measure.offsetWidth > targetWidth) break;
      endChars++;
    }

    // Ensure minimum characters on each side for readability
    const minChars = 4;
    const prevStartChars = startChars;
    const prevEndChars = endChars;

    if (startChars < minChars && text.length > minChars * 2 + 1) {
      startChars = minChars;
    }
    if (endChars < minChars && text.length > minChars * 2 + 1) {
      endChars = minChars;
    }

    // Re-measure after enforcing minChars to prevent overflow
    if (startChars !== prevStartChars || endChars !== prevEndChars) {
      measure.textContent = text.slice(0, startChars) + ellipsis + text.slice(-endChars);
      if (measure.offsetWidth > targetWidth) {
        // Revert to previous values if minChars enforcement causes overflow
        startChars = prevStartChars;
        endChars = prevEndChars;
      }
    }

    // If combined chars would exceed text length, show full text
    if (startChars + endChars >= text.length) {
      setDisplayText(text);
      setIsTruncated(false);
      return;
    }

    const result = text.slice(0, startChars) + ellipsis + text.slice(-endChars);
    setDisplayText(result);
    setIsTruncated(true);
  }, [text]);

  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    calculateTruncation();

    // Recalculate on resize (guard for jsdom/older browsers)
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      calculateTruncation();
    });

    const container = containerRef.current;
    if (container?.parentElement) {
      resizeObserver.observe(container.parentElement);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [calculateTruncation]);

  const content = (
    <span ref={containerRef} className={cn("block", isTruncated && "min-w-[360px]", className)}>
      {/* Hidden span for measuring text width */}
      <span ref={measureRef} className="invisible absolute whitespace-nowrap" aria-hidden="true" />
      {displayText}
    </span>
  );

  if (isTruncated) {
    return (
      <SimpleTooltip
        button={content}
        content={
          <span className={cn("max-w-xs break-all font-mono text-xs", tooltipContentClassName)}>
            {text}
          </span>
        }
        side="top"
        asChild
        delayDuration={tooltipDelay}
      />
    );
  }

  return content;
}
