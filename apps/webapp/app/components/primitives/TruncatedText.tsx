import { type ReactNode, useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import { SimpleTooltip } from "./Tooltip";

/**
 * One line of text that truncates with an ellipsis. When it's cut off, hovering shows the full
 * text in a tooltip; when it fits, there's no tooltip.
 */
export function TruncatedText({
  text,
  className,
  tooltip,
}: {
  text: string;
  className?: string;
  /** Shown instead of `text` in the tooltip. */
  tooltip?: ReactNode;
}) {
  // A callback ref, so a span remounted by the tooltip wrapper is measured again.
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    if (!element) return;
    const check = () => setIsTruncated(element.scrollWidth > element.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, text]);

  const span = (
    <span ref={setElement} className={cn("truncate", className)}>
      {text}
    </span>
  );

  if (!isTruncated) return span;
  return <SimpleTooltip asChild disableHoverableContent button={span} content={tooltip ?? text} />;
}
