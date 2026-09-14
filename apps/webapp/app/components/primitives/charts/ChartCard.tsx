import { Maximize2 } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../Dialog";
import { ModalCloseButton } from "../ModalCloseButton";
import { TITLE_BAR_CHROME } from "../Tabs";
import { Card } from "./Card";
import { ChartSyncProvider, useChartSync } from "./ChartSyncContext";

type ChartCardProps = {
  /**
   * Title shown in the card header (and the fullscreen dialog header). If omitted, the header
   * collapses to a right-aligned toolbar row (accessory + maximize) instead of a `Card.Header`.
   */
  title?: ReactNode;
  /**
   * Fullscreen dialog header's title, when it must differ from the card's — e.g. a card with
   * no title (a titleless toolbar) that still wants a title once it's alone in the dialog.
   * Defaults to `title`.
   */
  fullscreenTitle?: ReactNode;
  /** Chart content. Also used in the fullscreen dialog unless `fullscreenChildren` is set. */
  children: ReactNode;
  /** Optional distinct content for the fullscreen dialog (defaults to `children`). */
  fullscreenChildren?: ReactNode;
  /** Show the maximize button + enable the fullscreen dialog. Defaults to true. */
  maximizable?: boolean;
  /** Extra classes for the inner Card. */
  className?: string;
  /** Classes for the content wrapper. Defaults to `"min-h-0 flex-1 px-2"`. */
  contentClassName?: string;
  /** Classes for the fullscreen content wrapper. Defaults to `"min-h-0 w-full flex-1 overflow-hidden pt-4"`. */
  fullscreenContentClassName?: string;
  /** Whether the card keeps its default padding (`pb-2` + top padding). Defaults to true. */
  padded?: boolean;
  /**
   * `"tabs"` renders the title as a full-width bar the height of a filter bar,
   * with the divider and the tabs' underlines meeting at its bottom edge. Pass
   * the tab buttons as `title`; the bar itself is supplied here.
   */
  headerVariant?: "default" | "tabs";
  /**
   * Keeps the titleless toolbar's accessory + Maximize always visible instead of hover-revealed.
   * Used when the card has no room for a hover affordance to be discoverable (e.g. it's the
   * whole visible surface, like the agent table). Charts/queue cards default to hover-reveal.
   */
  alwaysShowControls?: boolean;
  /** Controls rendered before the maximize button, in the card header and the fullscreen header. */
  accessory?: ReactNode;
  /**
   * Fullscreen header's accessory, when it must differ from the card's — e.g. a hover-reveal
   * control that needs to render always-visible once its `.group` ancestor is gone behind the
   * dialog's portal. Defaults to `accessory`.
   */
  fullscreenAccessory?: ReactNode;
  /** Content below the chart. Card only — the fullscreen dialog gives the chart the whole area. */
  footer?: ReactNode;
  /**
   * Name for the fullscreen dialog, used when the title is a node rather than plain text (a
   * dialog must be named). Defaults to a plain-text title, else "Chart".
   */
  ariaLabel?: string;
};

/**
 * Chart card with a title and an optional "Maximize" button that opens the chart
 * fullscreen. Mirrors the dashboard QueryWidget (hover-revealed button + "v" shortcut).
 */
export function ChartCard({
  title,
  fullscreenTitle,
  children,
  fullscreenChildren,
  maximizable = true,
  className,
  contentClassName,
  fullscreenContentClassName,
  padded = true,
  headerVariant = "default",
  accessory,
  fullscreenAccessory,
  alwaysShowControls = false,
  footer,
  ariaLabel,
}: ChartCardProps) {
  const resolvedFullscreenAccessory = fullscreenAccessory ?? accessory;
  const resolvedFullscreenTitle = fullscreenTitle ?? title;
  // A title of 0 or "" is still no title, but don't treat other falsy-looking nodes as missing.
  const hasTitle = title != null && title !== "";
  const hasFullscreenTitle = resolvedFullscreenTitle != null && resolvedFullscreenTitle !== "";
  const dialogName =
    typeof resolvedFullscreenTitle === "string" && resolvedFullscreenTitle !== ""
      ? resolvedFullscreenTitle
      : (ariaLabel ?? "Chart");
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

  function buildMaximizeButton(alwaysVisible: boolean) {
    return (
      <SimpleTooltip
        button={
          <span
            className={
              alwaysVisible
                ? undefined
                : "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            }
          >
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
  }

  const maximizeButton = buildMaximizeButton(false);
  const alwaysVisibleMaximizeButton = buildMaximizeButton(true);

  return (
    <div ref={containerRef} className="group h-full min-h-0 overflow-hidden">
      <Card
        padded={padded}
        className={cn(
          "h-full overflow-hidden px-0",
          padded && cn("pb-2", tabbed ? "pt-0" : "pt-3"),
          className
        )}
      >
        {tabbed ? (
          <div className={cn(TITLE_BAR_CHROME, "items-stretch justify-between gap-x-0 pl-4 pr-2")}>
            <div className="flex items-stretch gap-x-4">{title}</div>
            {(accessory || maximizable) && (
              <div className="flex items-center">
                {accessory}
                {maximizable && maximizeButton}
              </div>
            )}
          </div>
        ) : hasTitle ? (
          <Card.Header>
            <div className="flex items-center gap-1.5">{title}</div>
            {(accessory || maximizable) && (
              <Card.Accessory>
                {accessory}
                {maximizable && maximizeButton}
              </Card.Accessory>
            )}
          </Card.Header>
        ) : (
          <div className="flex items-center justify-end gap-1 px-1 py-1">
            {accessory}
            {maximizable && (alwaysShowControls ? alwaysVisibleMaximizeButton : maximizeButton)}
          </div>
        )}
        <div className={cn(contentClassName ?? "min-h-0 flex-1 px-2", tabbed && "pt-3")}>
          {children}
        </div>
        {footer ? <div className="px-2 pt-2">{footer}</div> : null}
      </Card>

      {maximizable && (
        <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
          <DialogContent
            fullscreen
            showCloseButton={!resolvedFullscreenAccessory}
            className="flex flex-col bg-background-bright"
          >
            {/* Radix names the dialog from its Title. The visible title is often a rich node
                (legend, live readout), so name it with a text-only copy instead. */}
            <DialogTitle className="sr-only">{dialogName}</DialogTitle>
            {/* In fullscreen, space the title's legend (the flex-col title node) further from the
                title — gap-6 instead of the card's gap-1. */}
            <DialogHeader
              className={cn(
                "[&>span]:gap-6",
                resolvedFullscreenAccessory &&
                  cn(
                    "flex-row items-start gap-2",
                    hasFullscreenTitle ? "justify-between" : "justify-end"
                  )
              )}
            >
              {tabbed ? (
                <div className="flex items-stretch gap-x-4">{resolvedFullscreenTitle}</div>
              ) : (
                resolvedFullscreenTitle
              )}
              {resolvedFullscreenAccessory ? (
                <div className="flex items-center gap-0.5">
                  {resolvedFullscreenAccessory}
                  <ModalCloseButton />
                </div>
              ) : null}
            </DialogHeader>
            <div
              className={cn(
                fullscreenContentClassName ?? "min-h-0 w-full flex-1 overflow-hidden pt-4"
              )}
            >
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
