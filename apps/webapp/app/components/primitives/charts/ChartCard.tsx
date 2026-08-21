import { Maximize2 } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { Dialog, DialogContent, DialogHeader } from "../Dialog";
import { TITLE_BAR_CHROME } from "../Tabs";
import { Card } from "./Card";
import { ChartSyncProvider, useChartSync } from "./ChartSyncContext";

type ChartCardProps = {
  /** Title shown in the card header (and the fullscreen dialog header). */
  title: ReactNode;
  /** Chart content. Also used in the fullscreen dialog unless `fullscreenChildren` is set. */
  children: ReactNode;
  /** Optional distinct content for the fullscreen dialog (defaults to `children`). */
  fullscreenChildren?: ReactNode;
  /** Show the maximize button + enable the fullscreen dialog. Defaults to true. */
  maximizable?: boolean;
  /** Extra classes for the inner Card. */
  className?: string;
  /**
   * `"tabs"` renders the title as a full-width bar the height of a filter bar,
   * with the divider and the tabs' underlines meeting at its bottom edge. Pass
   * the tab buttons as `title`; the bar itself is supplied here.
   */
  headerVariant?: "default" | "tabs";
};

/**
 * Chart card with a title and an optional "Maximize" button that opens the chart
 * fullscreen. Mirrors the dashboard QueryWidget (hover-revealed button + "v" shortcut).
 */
export function ChartCard({
  title,
  children,
  fullscreenChildren,
  maximizable = true,
  className,
  headerVariant = "default",
}: ChartCardProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // A maximized chart is its own sync group: hover + drag-select shouldn't mirror onto the
  // (hidden) sibling charts behind the dialog. Give it a fresh provider with isolated state,
  // but inherit the page group's onZoom so drag-to-zoom still sets the time filter.
  const parentSync = useChartSync();

  // "v" toggles fullscreen for the hovered card.
  useShortcutKeys({
    shortcut: { key: "v" },
    action: useCallback(() => {
      const isHovered = containerRef.current?.matches(":hover");
      if (!isFullscreen && !isHovered) return;
      setIsFullscreen((prev) => !prev);
    }, [isFullscreen]),
    disabled: !maximizable,
  });

  const tabbed = headerVariant === "tabs";

  const maximizeButton = (
    <SimpleTooltip
      button={
        <span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="minimal/small"
            LeadingIcon={Maximize2}
            aria-label="Maximize chart"
            leadingIconClassName="text-text-dimmed group-hover/button:text-text-bright"
            onClick={() => setIsFullscreen(true)}
            className="px-1!"
          />
        </span>
      }
      content={
        <span className="flex items-center gap-1">
          Maximize
          <ShortcutKey shortcut={{ key: "v" }} variant="small/bright" />
        </span>
      }
      asChild
    />
  );

  return (
    <div ref={containerRef} className="group h-full min-h-0 overflow-hidden">
      <Card className={cn("h-full overflow-hidden px-0 pb-2", tabbed ? "pt-0" : "pt-3", className)}>
        {tabbed ? (
          <div className={cn(TITLE_BAR_CHROME, "items-stretch justify-between gap-x-0 px-2")}>
            <div className="flex items-stretch gap-x-4">{title}</div>
            {maximizable && <div className="flex items-center">{maximizeButton}</div>}
          </div>
        ) : (
          <Card.Header>
            <div className="flex items-center gap-1.5">{title}</div>
            {maximizable && <Card.Accessory>{maximizeButton}</Card.Accessory>}
          </Card.Header>
        )}
        <div className={cn("min-h-0 flex-1 px-2", tabbed && "pt-3")}>{children}</div>
      </Card>

      {maximizable && (
        <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
          <DialogContent fullscreen className="flex flex-col bg-background-bright">
            {/* In fullscreen, space the title's legend (the flex-col title node) further from the
                title — gap-6 instead of the card's gap-1. */}
            <DialogHeader className="[&>span]:gap-6">
              {tabbed ? <div className="flex items-stretch gap-x-4">{title}</div> : title}
            </DialogHeader>
            <div className="min-h-0 w-full flex-1 overflow-hidden pt-4">
              {parentSync ? (
                <ChartSyncProvider onZoom={parentSync.onZoom}>
                  {fullscreenChildren ?? children}
                </ChartSyncProvider>
              ) : (
                (fullscreenChildren ?? children)
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
