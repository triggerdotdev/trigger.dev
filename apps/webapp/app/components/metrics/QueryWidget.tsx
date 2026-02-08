import { Card } from "~/components/primitives/charts/Card";
import { useState, type ReactNode } from "react";
import { type OutputColumnMetadata } from "@internal/tsql";
import { z } from "zod";
import { assertNever } from "assert-never";
import { TSQLResultsTable } from "../code/TSQLResultsTable";
import { QueryResultsChart } from "../code/QueryResultsChart";
import { BigNumberCard } from "../primitives/charts/BigNumberCard";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../primitives/Dialog";
import { Button } from "../primitives/Buttons";
import {
  ArrowsPointingOutIcon,
  DocumentDuplicateIcon,
  PencilIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { LoadingBarDivider } from "../primitives/LoadingBarDivider";
import { Callout } from "../primitives/Callout";
import { ChartBarIcon } from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverVerticalEllipseTrigger,
} from "../primitives/Popover";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";
import { DialogClose } from "@radix-ui/react-dialog";

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

const BigNumberAggregationType = z.union([
  z.literal("sum"),
  z.literal("avg"),
  z.literal("count"),
  z.literal("min"),
  z.literal("max"),
  z.literal("first"),
  z.literal("last"),
]);
export type BigNumberAggregationType = z.infer<typeof BigNumberAggregationType>;

const BigNumberSortDirection = z.union([z.literal("asc"), z.literal("desc")]);

const bigNumberConfigOptions = {
  column: z.string(),
  aggregation: BigNumberAggregationType,
  sortDirection: BigNumberSortDirection.optional(),
  abbreviate: z.boolean().default(false),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
};

const BigNumberConfiguration = z.object({ ...bigNumberConfigOptions });
export type BigNumberConfiguration = z.infer<typeof BigNumberConfiguration>;

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
  z.object({
    type: z.literal("bignumber"),
    ...bigNumberConfigOptions,
  }),
]);

export type QueryWidgetConfig = z.infer<typeof QueryWidgetConfig>;

/** Result data containing rows and column metadata */
export type QueryWidgetData = {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
};

/** Widget configuration with optional result data (used for edit callbacks) */
export type WidgetData = {
  title: string;
  query: string;
  display: QueryWidgetConfig;
  /** The current result data from the widget */
  resultData?: QueryWidgetData;
};

export type QueryWidgetProps = {
  title: ReactNode;
  /** String title for rename dialog (optional - if not provided, rename won't be available) */
  titleString?: string;
  isLoading?: boolean;
  error?: string;
  data: QueryWidgetData;
  config: QueryWidgetConfig;
  accessory?: ReactNode;
  isResizing?: boolean;
  isDraggable?: boolean;
  /** Callback when edit is clicked. Receives the current data. */
  onEdit?: (data: QueryWidgetData) => void;
  /** Callback when rename is clicked. Receives the new title. */
  onRename?: (newTitle: string) => void;
  /** Callback when delete is clicked. */
  onDelete?: () => void;
  /** Callback when duplicate is clicked. Receives the current data. */
  onDuplicate?: (data: QueryWidgetData) => void;
};

export function QueryWidget({
  title,
  titleString,
  accessory,
  isLoading,
  error,
  isResizing,
  isDraggable,
  onEdit,
  onRename,
  onDelete,
  onDuplicate,
  ...props
}: QueryWidgetProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(titleString ?? "");

  const hasMenu = onEdit || onRename || onDelete || onDuplicate;

  return (
    <div className="h-full">
      <Card className={cn("h-full overflow-hidden px-0 pb-0", isResizing && "select-none")}>
        <Card.Header draggable={isDraggable}>
          <div className="flex items-center gap-1.5">{title}</div>
          <Card.Accessory>
            {accessory}
            <Button
              variant="tertiary/small"
              LeadingIcon={ArrowsPointingOutIcon}
              onClick={() => setIsFullscreen(true)}
            />
            {hasMenu && (
              <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
                <PopoverVerticalEllipseTrigger isOpen={isMenuOpen} />
                <PopoverContent align="end" className="p-0">
                  <div className="flex flex-col gap-1 p-1">
                    {onEdit && (
                      <PopoverMenuItem
                        icon={PencilSquareIcon}
                        title="Edit chart"
                        onClick={() => {
                          onEdit(props.data);
                          setIsMenuOpen(false);
                        }}
                      />
                    )}
                    {onRename && (
                      <PopoverMenuItem
                        icon={PencilIcon}
                        title="Rename"
                        onClick={() => {
                          setRenameValue(titleString ?? "");
                          setIsRenameDialogOpen(true);
                          setIsMenuOpen(false);
                        }}
                      />
                    )}
                    {onDuplicate && (
                      <PopoverMenuItem
                        icon={DocumentDuplicateIcon}
                        title="Duplicate chart"
                        onClick={() => {
                          onDuplicate(props.data);
                          setIsMenuOpen(false);
                        }}
                        className="pr-4"
                      />
                    )}
                    {onDelete && (
                      <PopoverMenuItem
                        icon={TrashIcon}
                        title="Delete chart"
                        leadingIconClassName="text-error"
                        className="text-error hover:!bg-error/10"
                        onClick={() => {
                          onDelete();
                          setIsMenuOpen(false);
                        }}
                      />
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}
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

      {/* Rename Dialog */}
      {onRename && (
        <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>Rename chart</DialogHeader>
            <form
              className="space-y-4 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (renameValue.trim()) {
                  onRename(renameValue.trim());
                  setIsRenameDialogOpen(false);
                }
              }}
            >
              <InputGroup>
                <Label>Title</Label>
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Chart title"
                  autoFocus
                />
              </InputGroup>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="tertiary/medium">Cancel</Button>
                </DialogClose>
                <Button type="submit" variant="primary/medium" disabled={!renameValue.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
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
    case "bignumber": {
      return (
        <>
          <BigNumberCard
            rows={data.rows}
            columns={data.columns}
            config={config}
            isLoading={isLoading}
          />
          <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
            <DialogContent fullscreen>
              <DialogHeader>{title}</DialogHeader>
              <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center pt-4">
                <BigNumberCard
                  rows={data.rows}
                  columns={data.columns}
                  config={config}
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
