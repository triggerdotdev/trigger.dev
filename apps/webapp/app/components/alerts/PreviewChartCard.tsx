import { Button } from "~/components/primitives/Buttons";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { ChartTileTitle } from "~/components/queues/ChartTileTitle";
import { ChartLegend, type ChartLegendItem } from "./ChartLegend";

/**
 * The chrome every chart branch wears, following the queue detail page's own
 * `QueueMetricChartCard` (`~/components/queues/QueueMetricCards.tsx`): the real `ChartCard`,
 * a title row with an optional info icon, and the inline legend under the title rather than
 * a legend row of its own under the plot.
 *
 * `QueueMetricChartCard` itself could not be reused — it is welded to `useQueueMetric`, a
 * live ClickHouse query needing org/project/environment ids this loader-less route has none
 * of — so its header is mirrored. Everything below the header is the primitive's: `maximizable`
 * is left at its default, so every chart gets the Maximize button, its `v` shortcut and the
 * fullscreen dialog.
 */
export function PreviewChartCard({
  title,
  info,
  legend,
  onResetRange,
  className,
  alwaysShowControls,
  fullscreenChildren,
  accessory,
  tile,
  fullscreenLegend,
  fullscreenAccessory,
  children,
}: {
  title: string;
  info?: string;
  legend?: ChartLegendItem[];
  onResetRange?: () => void;
  className?: string;
  alwaysShowControls?: boolean;
  fullscreenChildren?: React.ReactNode;
  accessory?: React.ReactNode;
  tile?: { peak: string | null };
  fullscreenLegend?: ChartLegendItem[];
  fullscreenAccessory?: React.ReactNode;
  children: React.ReactNode;
}) {
  const expandedTitle = (
    <ChartTileTitle
      label={title}
      description={info}
      peak={tile?.peak ?? null}
      legend={(fullscreenLegend ?? legend)?.map(({ color, label }) => ({ color, label }))}
      titleAccessory={
        onResetRange ? (
          <Button variant="minimal/small" onClick={onResetRange}>
            Reset zoom
          </Button>
        ) : undefined
      }
    />
  );
  if (tile) {
    return (
      <ChartCard
        className={className}
        alwaysShowControls={alwaysShowControls}
        fullscreenChildren={fullscreenChildren}
        accessory={accessory}
        fullscreenAccessory={fullscreenAccessory}
        contentClassName="min-h-0 flex-1 pr-2"
        headerPaddingClassName="pl-1"
        fullscreenTitle={expandedTitle}
        title={
          <ChartTileTitle
            label={title}
            description={info}
            peak={tile.peak}
            truncate
            legendNode={legend && <ChartLegend items={legend} maxInline={1} />}
          />
        }
      >
        {children}
      </ChartCard>
    );
  }
  const header = () => (
    <span className="flex flex-col gap-1">
      {/* DEC-070 (live pass) dropped the "· depth · 6 in scope · last 12h" readout: the window is written on the
              axis under the plot. */}
      <span className="flex items-baseline gap-2">
        <span className="flex items-center gap-1">
          {title}
          {info && (
            <InfoIconTooltip
              content={info}
              contentClassName="max-w-[300px]"
              disableHoverableContent
              delayDuration={500}
            />
          )}
        </span>
        {onResetRange && (
          <Button variant="minimal/small" onClick={onResetRange}>
            Reset zoom
          </Button>
        )}
      </span>
      {legend && <ChartLegend items={legend} />}
    </span>
  );
  return (
    <ChartCard
      className={className}
      alwaysShowControls={alwaysShowControls}
      fullscreenChildren={fullscreenChildren}
      accessory={accessory}
      contentClassName="min-h-0 flex-1 pr-2"
      headerPaddingClassName="pl-1"
      title={header()}
      fullscreenTitle={expandedTitle}
    >
      {children}
    </ChartCard>
  );
}
