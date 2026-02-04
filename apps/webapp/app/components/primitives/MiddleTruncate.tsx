import { useRef, useState, useLayoutEffect, useCallback } from "react";
import { cn } from "~/utils/cn";
import { SimpleTooltip } from "./Tooltip";

type MiddleTruncateProps = {
  text: string;
  className?: string;
};

/**
 * A component that truncates text in the middle, showing the beginning and end.
 * Shows the full text in a tooltip on hover when truncated.
 *
 * Example: "namespace:category:subcategory:task-name" becomes "namespace:cat…task-name"
 */
export function MiddleTruncate({ text, className }: MiddleTruncateProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [displayText, setDisplayText] = useState(text);
  const [isTruncated, setIsTruncated] = useState(false);

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
    <span
      ref={containerRef}
      className={cn("block", isTruncated && "min-w-[360px]", className)}
    >
      {/* Hidden span for measuring text width */}
      <span
        ref={measureRef}
        className="invisible absolute whitespace-nowrap"
        aria-hidden="true"
      />
      {displayText}
    </span>
  );

  if (isTruncated) {
    return (
      <SimpleTooltip
        button={content}
        content={<span className="max-w-xs break-all font-mono text-xs">{text}</span>}
        side="top"
        asChild
      />
    );
  }

  return content;
}
