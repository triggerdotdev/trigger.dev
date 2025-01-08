import * as Ariakit from "@ariakit/react";
import type { RuntimeEnvironment } from "@trigger.dev/database";
import type { ReactNode } from "react";
import { startTransition, useCallback, useMemo, useState } from "react";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { DateField } from "~/components/primitives/DateField";
import { DateTime } from "~/components/primitives/DateTime";
import { Label } from "~/components/primitives/Label";
import {
  ComboBox,
  ComboboxProvider,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { useSearchParams } from "~/hooks/useSearchParam";
import { Button } from "../../primitives/Buttons";

export type DisplayableEnvironment = Pick<RuntimeEnvironment, "type" | "id"> & {
  userName?: string;
};

export function FilterMenuProvider({
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

export function EnvironmentsDropdown({
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

export function AppliedEnvironmentFilter({
  possibleEnvironments,
}: {
  possibleEnvironments: DisplayableEnvironment[];
}) {
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

export function CreatedAtDropdown({
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
  setFilterType?: (type: "daterange" | undefined) => void;
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

export function AppliedPeriodFilter() {
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

export function CustomDateRangeDropdown({
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

export function AppliedCustomDateRangeFilter() {
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

export function appliedSummary(values: string[], maxValues = 3) {
  if (values.length === 0) {
    return null;
  }

  if (values.length > maxValues) {
    return `${values.slice(0, maxValues).join(", ")} + ${values.length - maxValues} more`;
  }

  return values.join(", ");
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
