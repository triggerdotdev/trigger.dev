import { Card } from "~/components/primitives/charts/Card";
import { useState, type ReactNode } from "react";
import { type OutputColumnMetadata } from "@internal/tsql";
import { z } from "zod";
import { assertNever } from "assert-never";
import { TSQLResultsTable } from "../code/TSQLResultsTable";
import { QueryResultsChart } from "../code/QueryResultsChart";
import { Dialog, DialogContent, DialogHeader } from "../primitives/Dialog";
import { Button } from "../primitives/Buttons";
import { ArrowsPointingOutIcon } from "@heroicons/react/20/solid";
import { LoadingBarDivider } from "../primitives/LoadingBarDivider";
import { Callout } from "../primitives/Callout";
import { ChartBarIcon } from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";

const ChartType = z.union([z.literal("bar"), z.literal("line")]);
export type ChartType = z.infer<typeof ChartType>;

const SortDirection = z.union([z.literal("asc"), z.literal("desc")]);
export type SortDirection = z.infer<typeof SortDirection>;

const AggregationType = z.union([
  z.literal("sum"),
  z.literal("avg"),
  z.literal("count"),
  z.literal("min"),
  z.literal("max"),
]);
export type AggregationType = z.infer<typeof AggregationType>;

const chartConfigOptions = {
  chartType: ChartType,
  xAxisColumn: z.string().nullable(),
  yAxisColumns: z.string().array(),
  groupByColumn: z.string().nullable(),
  stacked: z.boolean(),
  sortByColumn: z.string().nullable(),
  sortDirection: SortDirection,
  aggregation: AggregationType,
};

const ChartConfiguration = z.object({ ...chartConfigOptions });
export type ChartConfiguration = z.infer<typeof ChartConfiguration>;

export const QueryWidgetConfig = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("table"),
    prettyFormatting: z.boolean().default(true),
    sorting: z
      .array(
        z.object({
          desc: z.boolean(),
          id: z.string(),
        })
      )
      .default([]),
  }),
  z.object({
    type: z.literal("chart"),
    ...chartConfigOptions,
  }),
]);

export type QueryWidgetConfig = z.infer<typeof QueryWidgetConfig>;

type QueryWidgetData = {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
};

export type QueryWidgetProps = {
  title: ReactNode;
  isLoading?: boolean;
  error?: string;
  data: QueryWidgetData;
  config: QueryWidgetConfig;
  accessory?: ReactNode;
  isResizing?: boolean;
  isDraggable?: boolean;
};

export function QueryWidget({
  title,
  accessory,
  isLoading,
  error,
  isResizing,
  isDraggable,
  ...props
}: QueryWidgetProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  return (
    <Card className={cn("h-full overflow-hidden px-0 pb-0", isResizing && "select-none")}>
      <Card.Header draggable={isDraggable}>
        <div className="flex items-center gap-1.5">{title}</div>
        <Card.Accessory>
          {accessory}
          <Button
            variant="minimal/small"
            LeadingIcon={ArrowsPointingOutIcon}
            onClick={() => setIsFullscreen(true)}
          />
        </Card.Accessory>
      </Card.Header>
      <LoadingBarDivider isLoading={isLoading ?? false} className="bg-transparent" />
      <Card.Content className="min-h-0 flex-1 overflow-hidden p-0">
        {isResizing ? (
          <div className="flex h-full flex-1 items-center justify-center p-3">
            <div className="flex flex-col items-center gap-1 text-text-dimmed">
              <ChartBarIcon className="size-10 text-text-dimmed" />{" "}
              <span className="text-base font-medium">Resizing...</span>
            </div>
          </div>
        ) : error ? (
          <div className="p-3">
            <Callout variant="error">{error}</Callout>
          </div>
        ) : (
          <QueryWidgetBody
            {...props}
            title={title}
            isFullscreen={isFullscreen}
            setIsFullscreen={setIsFullscreen}
            isLoading={isLoading ?? false}
          />
        )}
      </Card.Content>
    </Card>
  );
}

type QueryWidgetBodyProps = {
  title: ReactNode;
  data: QueryWidgetData;
  config: QueryWidgetConfig;
  isFullscreen: boolean;
  setIsFullscreen: (open: boolean) => void;
  isLoading: boolean;
};

function QueryWidgetBody({
  title,
  data,
  config,
  isFullscreen,
  setIsFullscreen,
  isLoading,
}: QueryWidgetBodyProps) {
  const type = config.type;

  switch (type) {
    case "table": {
      return (
        <>
          <TSQLResultsTable
            rows={data.rows}
            columns={data.columns}
            prettyFormatting={config.prettyFormatting}
            sorting={config.sorting}
          />
          <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
            <DialogContent fullscreen>
              <DialogHeader>{title}</DialogHeader>
              <div className="h-full min-h-0 w-full flex-1 overflow-hidden pt-4">
                <TSQLResultsTable
                  rows={data.rows}
                  columns={data.columns}
                  prettyFormatting={config.prettyFormatting}
                  sorting={config.sorting}
                />
              </div>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    case "chart": {
      return (
        <>
          <QueryResultsChart
            rows={data.rows}
            columns={data.columns}
            config={config}
            onViewAllLegendItems={() => setIsFullscreen(true)}
          />
          <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
            <DialogContent fullscreen>
              <DialogHeader>{title}</DialogHeader>
              <div className="h-full min-h-0 w-full flex-1 overflow-hidden pt-4">
                <QueryResultsChart
                  rows={data.rows}
                  columns={data.columns}
                  config={config}
                  onViewAllLegendItems={() => setIsFullscreen(true)}
                  isLoading={isLoading}
                />
              </div>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    default: {
      assertNever(type);
    }
  }
}
