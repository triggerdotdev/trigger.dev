import * as Ariakit from "@ariakit/react";
import { CalendarIcon, CpuChipIcon, Squares2X2Icon, TrashIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import type { BatchTaskRunStatus, RuntimeEnvironment } from "@trigger.dev/database";
import { ListFilterIcon } from "lucide-react";
import type { ReactNode } from "react";
import { startTransition, useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { DateField } from "~/components/primitives/DateField";
import { DateTime } from "~/components/primitives/DateTime";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
  ComboboxProvider,
  SelectButtonItem,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { Button } from "../../primitives/Buttons";
import {
  allBatchStatuses,
  BatchStatusCombo,
  batchStatusTitle,
  descriptionForBatchStatus,
} from "./BatchStatus";

export const BatchStatus = z.enum(allBatchStatuses);

export const BatchListFilters = z.object({
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  environments: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.string().array().optional()
  ),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    BatchStatus.array().optional()
  ),
  period: z.preprocess((value) => (value === "all" ? undefined : value), z.string().optional()),
  id: z.string().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

export type BatchListFilters = z.infer<typeof BatchListFilters>;

type DisplayableEnvironment = Pick<RuntimeEnvironment, "type" | "id"> & {
  userName?: string;
};

type BatchFiltersProps = {
  possibleEnvironments: DisplayableEnvironment[];
  hasFilters: boolean;
};

export function BatchFilters(props: BatchFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("environments") ||
    searchParams.has("id") ||
    searchParams.has("period") ||
    searchParams.has("from") ||
    searchParams.has("to");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1">
      <FilterMenu {...props} />
      <AppliedFilters {...props} />
      {hasFilters && (
        <Form className="h-6">
          {searchParams.has("showChildTasks") && (
            <input
              type="hidden"
              name="showChildTasks"
              value={searchParams.get("showChildTasks") as string}
            />
          )}
          <Button variant="minimal/small" LeadingIcon={TrashIcon}>
            Clear all
          </Button>
        </Form>
      )}
    </div>
  );
}

const filterTypes = [
  {
    name: "statuses",
    title: "Status",
    icon: (
      <div className="flex size-4 items-center justify-center">
        <div className="size-3 rounded-full border-2 border-text-dimmed" />
      </div>
    ),
  },
  { name: "environments", title: "Environment", icon: <CpuChipIcon className="size-4" /> },
  { name: "created", title: "Created", icon: <CalendarIcon className="size-4" /> },
  { name: "daterange", title: "Custom date range", icon: <CalendarIcon className="size-4" /> },
  { name: "batch", title: "Batch ID", icon: <Squares2X2Icon className="size-4" /> },
] as const;

type FilterType = (typeof filterTypes)[number]["name"];

const shortcut = { key: "f" };

function FilterMenu(props: BatchFiltersProps) {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const filterTrigger = (
    <SelectTrigger
      icon={
        <div className="flex size-4 items-center justify-center">
          <ListFilterIcon className="size-3.5" />
        </div>
      }
      variant={"minimal/small"}
      shortcut={shortcut}
      tooltipTitle={"Filter runs"}
    >
      Filter
    </SelectTrigger>
  );

  return (
    <FilterMenuProvider onClose={() => setFilterType(undefined)}>
      {(search, setSearch) => (
        <Menu
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          trigger={filterTrigger}
          filterType={filterType}
          setFilterType={setFilterType}
          {...props}
        />
      )}
    </FilterMenuProvider>
  );
}

function FilterMenuProvider({
  children,
  onClose,
}: {
  children: (search: string, setSearch: (value: string) => void) => React.ReactNode;
  onClose?: () => void;
}) {
  const [searchValue, setSearchValue] = useState("");

  return (
    <ComboboxProvider
      resetValueOnHide
      setValue={(value) => {
        startTransition(() => {
          setSearchValue(value);
        });
      }}
      setOpen={(open) => {
        if (!open && onClose) {
          onClose();
        }
      }}
    >
      {children(searchValue, setSearchValue)}
    </ComboboxProvider>
  );
}

function AppliedFilters({ possibleEnvironments }: BatchFiltersProps) {
  return (
    <>
      <AppliedStatusFilter />
      <AppliedEnvironmentFilter possibleEnvironments={possibleEnvironments} />
      <AppliedPeriodFilter />
      <AppliedCustomDateRangeFilter />
      <AppliedBatchIdFilter />
    </>
  );
}

type MenuProps = {
  searchValue: string;
  clearSearchValue: () => void;
  trigger: React.ReactNode;
  filterType: FilterType | undefined;
  setFilterType: (filterType: FilterType | undefined) => void;
} & BatchFiltersProps;

function Menu(props: MenuProps) {
  switch (props.filterType) {
    case undefined:
      return <MainMenu {...props} />;
    case "statuses":
      return <StatusDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "environments":
      return <EnvironmentsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "created":
      return <CreatedAtDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "daterange":
      return <CustomDateRangeDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "batch":
      return <BatchIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ searchValue, trigger, clearSearchValue, setFilterType }: MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) => {
      if (item.name === "daterange") return false;
      return item.title.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue]);

  return (
    <SelectProvider virtualFocus={true}>
      {trigger}
      <SelectPopover>
        <ComboBox placeholder={"Filter by..."} shortcut={shortcut} value={searchValue} />
        <SelectList>
          {filtered.map((type, index) => (
            <SelectButtonItem
              key={type.name}
              onClick={() => {
                clearSearchValue();
                setFilterType(type.name);
              }}
              icon={type.icon}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              {type.title}
            </SelectButtonItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
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

function AppliedStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");

  if (statuses.length === 0) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Status"
                value={appliedSummary(
                  statuses.map((v) => batchStatusTitle(v as BatchTaskRunStatus))
                )}
                onRemove={() => del(["statuses", "cursor", "direction"])}
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function EnvironmentsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleEnvironments,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleEnvironments: DisplayableEnvironment[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ environments: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return possibleEnvironments.filter((item) => {
      const title = environmentTitle(item, item.userName);
      return title.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possibleEnvironments]);

  return (
    <SelectProvider value={values("environments")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder={"Filter by environment..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.id}
              value={item.id}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <EnvironmentLabel environment={item} userName={item.userName} />
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedEnvironmentFilter({
  possibleEnvironments,
}: Pick<BatchFiltersProps, "possibleEnvironments">) {
  const { values, del } = useSearchParams();

  if (values("environments").length === 0) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <EnvironmentsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Environment"
                value={appliedSummary(
                  values("environments").map((v) => {
                    const environment = possibleEnvironments.find((env) => env.id === v);
                    return environment ? environmentTitle(environment, environment.userName) : v;
                  })
                )}
                onRemove={() => del(["environments", "cursor", "direction"])}
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleEnvironments={possibleEnvironments}
        />
      )}
    </FilterMenuProvider>
  );
}

const timePeriods = [
  {
    label: "Last 5 mins",
    value: "5m",
  },
  {
    label: "Last 30 mins",
    value: "30m",
  },
  {
    label: "Last 1 hour",
    value: "1h",
  },
  {
    label: "Last 6 hours",
    value: "6h",
  },
  {
    label: "Last 1 day",
    value: "1d",
  },
  {
    label: "Last 3 days",
    value: "3d",
  },
  {
    label: "Last 7 days",
    value: "7d",
  },
  {
    label: "Last 14 days",
    value: "14d",
  },
  {
    label: "Last 30 days",
    value: "30d",
  },
  {
    label: "All periods",
    value: "all",
  },
];

function CreatedAtDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  setFilterType,
  hideCustomRange,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  setFilterType?: (type: FilterType | undefined) => void;
  hideCustomRange?: boolean;
}) {
  const { value, replace } = useSearchParams();

  const from = value("from");
  const to = value("to");
  const period = value("period");

  const handleChange = (newValue: string) => {
    clearSearchValue();
    if (newValue === "all") {
      if (!period && !from && !to) return;

      replace({
        period: undefined,
        from: undefined,
        to: undefined,
        cursor: undefined,
        direction: undefined,
      });
      return;
    }

    if (newValue === "custom") {
      setFilterType?.("daterange");
      return;
    }

    replace({
      period: newValue,
      from: undefined,
      to: undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const filtered = useMemo(() => {
    return timePeriods.filter((item) =>
      item.label.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider
      value={from || to ? "custom" : period ?? "all"}
      setValue={handleChange}
      virtualFocus={true}
    >
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
      >
        <ComboBox placeholder={"Filter by period..."} value={searchValue} />
        <SelectList>
          {filtered.map((item) => (
            <SelectItem key={item.value} value={item.value} hideOnClick={false}>
              {item.label}
            </SelectItem>
          ))}
          {!hideCustomRange ? (
            <SelectItem value="custom" hideOnClick={false}>
              Custom date range
            </SelectItem>
          ) : null}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedPeriodFilter() {
  const { value, del } = useSearchParams();

  if (value("period") === undefined || value("period") === "all") {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <CreatedAtDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Created"
                value={
                  timePeriods.find((t) => t.value === value("period"))?.label ?? value("period")
                }
                onRemove={() => del(["period", "cursor", "direction"])}
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          hideCustomRange
        />
      )}
    </FilterMenuProvider>
  );
}

function CustomDateRangeDropdown({
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
  const fromSearch = dateFromString(value("from"));
  const toSearch = dateFromString(value("to"));
  const [from, setFrom] = useState(fromSearch);
  const [to, setTo] = useState(toSearch);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      period: undefined,
      cursor: undefined,
      direction: undefined,
      from: from?.getTime().toString(),
      to: to?.getTime().toString(),
    });

    setOpen(false);
  }, [from, to, replace]);

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
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>From (local time)</Label>
            <DateField
              label="From time"
              defaultValue={from}
              onValueChange={setFrom}
              granularity="second"
              showNowButton
              showClearButton
              variant="small"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>To (local time)</Label>
            <DateField
              label="To time"
              defaultValue={to}
              onValueChange={setTo}
              granularity="second"
              showNowButton
              showClearButton
              variant="small"
            />
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary/small"
              shortcut={{
                modifiers: ["meta"],
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

function AppliedCustomDateRangeFilter() {
  const { value, del } = useSearchParams();

  if (value("from") === undefined && value("to") === undefined) {
    return null;
  }

  const fromDate = dateFromString(value("from"));
  const toDate = dateFromString(value("to"));

  const rangeType = fromDate && toDate ? "range" : fromDate ? "from" : "to";

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <CustomDateRangeDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label={
                  rangeType === "range"
                    ? "Created"
                    : rangeType === "from"
                    ? "Created after"
                    : "Created before"
                }
                value={
                  <>
                    {rangeType === "range" ? (
                      <span>
                        <DateTime date={fromDate!} includeTime includeSeconds /> –{" "}
                        <DateTime date={toDate!} includeTime includeSeconds />
                      </span>
                    ) : rangeType === "from" ? (
                      <DateTime date={fromDate!} includeTime includeSeconds />
                    ) : (
                      <DateTime date={toDate!} includeTime includeSeconds />
                    )}
                  </>
                }
                onRemove={() => del(["period", "from", "to", "cursor", "direction"])}
              />
            </Ariakit.Select>
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
    } else if (batchId.length !== 27) {
      error = "Batch IDs are 27 characters long";
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
                modifiers: ["meta"],
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

function AppliedBatchIdFilter() {
  const { value, del } = useSearchParams();

  if (value("id") === undefined) {
    return null;
  }

  const batchId = value("id");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <BatchIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Batch ID"
                value={batchId}
                onRemove={() => del(["id", "cursor", "direction"])}
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function dateFromString(value: string | undefined | null): Date | undefined {
  if (!value) return;

  //is it an int?
  const int = parseInt(value);
  if (!isNaN(int)) {
    return new Date(int);
  }

  return new Date(value);
}

function appliedSummary(values: string[], maxValues = 3) {
  if (values.length === 0) {
    return null;
  }

  if (values.length > maxValues) {
    return `${values.slice(0, maxValues).join(", ")} + ${values.length - maxValues} more`;
  }

  return values.join(", ");
}
