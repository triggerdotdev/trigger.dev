import * as Ariakit from "@ariakit/react";
import {
  CalendarIcon,
  CpuChipIcon,
  Squares2X2Icon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import type { BatchTaskRunStatus, RuntimeEnvironment } from "@trigger.dev/database";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { z } from "zod";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { Button } from "../../primitives/Buttons";
import {
  allBatchStatuses,
  BatchStatusCombo,
  batchStatusTitle,
  descriptionForBatchStatus,
} from "./BatchStatus";
import {
  TimeFilter,
  appliedSummary,
  FilterMenuProvider,
  IdFilterDropdown,
  type IdFilterDropdownProps,
} from "./SharedFilters";
import { StatusIcon } from "~/assets/icons/StatusIcon";

export const BatchStatus = z.enum(allBatchStatuses);

export const BatchListFilters = z.object({
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    BatchStatus.array().optional()
  ),
  id: z.string().optional(),
  period: z.preprocess((value) => (value === "all" ? undefined : value), z.string().optional()),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

export type BatchListFilters = z.infer<typeof BatchListFilters>;

type BatchFiltersProps = {
  hasFilters: boolean;
};

export function BatchFilters(props: BatchFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters = searchParams.has("statuses") || searchParams.has("id");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <PermanentStatusFilter />
      <PermanentBatchIdFilter />
      <TimeFilter shortcut={{ key: "d" }} />
      {hasFilters && (
        <Form className="-ml-1 h-6">
          <Button
            variant="minimal/small"
            LeadingIcon={XMarkIcon}
            tooltip="Clear all filters"
            className="group-hover/button:bg-transparent"
            leadingIconClassName="group-hover/button:text-text-bright"
          />
        </Form>
      )}
    </div>
  );
}

const statuses = allBatchStatuses.map((status) => ({
  title: batchStatusTitle(status),
  value: status,
}));

function StatusDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ statuses: values, cursor: undefined, direction: undefined });
  };

  return (
    <SelectProvider value={values("statuses")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <SelectList>
          {statuses.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger className="group flex w-full flex-col py-0">
                    <BatchStatusCombo status={item.value} iconClassName="animate-none" />
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={9}>
                    <Paragraph variant="extra-small">
                      {descriptionForBatchStatus(item.value)}
                    </Paragraph>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const statusShortcut = { key: "s" };

function PermanentStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");
  const hasStatuses = statuses.length > 0;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: statusShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200}>
              <Ariakit.TooltipAnchor
                render={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasStatuses ? (
                  <AppliedFilter
                    label="Status"
                    icon={<StatusIcon className="size-3.5" />}
                    value={appliedSummary(
                      statuses.map((v) => batchStatusTitle(v as BatchTaskRunStatus))
                    )}
                    onRemove={() => del(["statuses", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <div className="grid size-4 place-items-center">
                      <div className="size-[75%] rounded-full border-2 border-text-bright" />
                    </div>
                    <span>Status</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by status</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={statusShortcut}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function validateBatchId(value: string): string | undefined {
  if (!value.startsWith("batch_")) return "Batch IDs start with 'batch_'";
  if (value.length !== 27 && value.length !== 31) return "Batch IDs are 27/32 characters long";
}

function BatchIdDropdown(
  props: Omit<IdFilterDropdownProps, "label" | "placeholder" | "paramKey" | "validate">
) {
  return (
    <IdFilterDropdown
      {...props}
      label="Batch ID"
      placeholder="batch_"
      paramKey="id"
      validate={validateBatchId}
    />
  );
}

const batchIdShortcut = { key: "b" };

function PermanentBatchIdFilter() {
  const { value, del } = useSearchParams();
  const batchId = value("id");
  const hasBatchId = batchId !== undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: batchIdShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <BatchIdDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200}>
              <Ariakit.TooltipAnchor
                render={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasBatchId ? (
                  <AppliedFilter
                    label="Batch ID"
                    icon={<Squares2X2Icon className="size-3.5" />}
                    value={batchId}
                    onRemove={() => del(["id", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <Squares2X2Icon className="size-3.5" />
                    <span>Batch ID</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by batch ID</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={batchIdShortcut}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}
