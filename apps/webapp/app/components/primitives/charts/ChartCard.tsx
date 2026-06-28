import { Maximize2 } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { Dialog, DialogContent, DialogHeader } from "../Dialog";
import { Card } from "./Card";

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
}: ChartCardProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={containerRef} className="group h-full min-h-0 overflow-hidden">
      <Card className={cn("h-full overflow-hidden px-0 pb-2 pt-3", className)}>
        <Card.Header>
          <div className="flex items-center gap-1.5">{title}</div>
          {maximizable && (
            <Card.Accessory>
              <SimpleTooltip
                button={
                  <span className="opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="minimal/small"
                      LeadingIcon={Maximize2}
                      leadingIconClassName="text-text-dimmed group-hover/button:text-text-bright"
                      onClick={() => setIsFullscreen(true)}
                      className="!px-1"
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
            </Card.Accessory>
          )}
        </Card.Header>
        <div className="min-h-0 flex-1 px-2">{children}</div>
      </Card>

      {maximizable && (
        <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
          <DialogContent fullscreen className="flex flex-col bg-background-bright">
            <DialogHeader>{title}</DialogHeader>
            <div className="min-h-0 w-full flex-1 overflow-hidden pt-4">
              {fullscreenChildren ?? children}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
