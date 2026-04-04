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
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
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
import { TimeFilter, appliedSummary, FilterMenuProvider } from "./SharedFilters";
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
        <Form className="h-6">
          <Button variant="minimal/small" LeadingIcon={XMarkIcon} tooltip="Clear all filters" />
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

  const filtered = useMemo(() => {
    return statuses.filter((item) => item.title.toLowerCase().includes(searchValue.toLowerCase()));
  }, [searchValue]);

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
        <ComboBox placeholder={"Filter by status..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
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
                  <Ariakit.Select ref={triggerRef as any} render={<div className="group cursor-pointer focus-custom" />} />
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
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary px-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <StatusIcon className="size-3.5" />
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

function BatchIdDropdown({
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
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const batchIdValue = value("id");

  const [batchId, setBatchId] = useState(batchIdValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      id: batchId === "" ? undefined : batchId?.toString(),
    });

    setOpen(false);
  }, [batchId, replace]);

  let error: string | undefined = undefined;
  if (batchId) {
    if (!batchId.startsWith("batch_")) {
      error = "Batch IDs start with 'batch_'";
    } else if (batchId.length !== 27 && batchId.length !== 31) {
      error = "Batch IDs are 27/32 characters long";
    }
  }

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Batch ID</Label>
            <Input
              placeholder="batch_"
              value={batchId ?? ""}
              onChange={(e) => setBatchId(e.target.value)}
              variant="small"
              className="w-[29ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !batchId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
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
                  <Ariakit.Select ref={triggerRef as any} render={<div className="group cursor-pointer focus-custom" />} />
                }
              >
                {hasBatchId ? (
                  <AppliedFilter
                    label="Batch ID"
                    icon={<Squares2X2Icon className="size-3.5" />}
                    value={batchId}
                    onRemove={() => del(["id", "cursor", "direction"])}
                    variant="secondary/small"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary px-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
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
