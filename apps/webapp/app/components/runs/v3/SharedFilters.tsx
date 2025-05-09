import * as Ariakit from "@ariakit/react";
import type { RuntimeEnvironment } from "@trigger.dev/database";
import parse from "parse-duration";
import type { ReactNode } from "react";
import { startTransition, useCallback, useState } from "react";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { DateField } from "~/components/primitives/DateField";
import { DateTime } from "~/components/primitives/DateTime";
import { Label } from "~/components/primitives/Label";
import { ComboboxProvider, SelectPopover, SelectProvider } from "~/components/primitives/Select";
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

const timePeriods = [
  {
    label: "1 min",
    value: "1m",
  },
  {
    label: "5 mins",
    value: "5m",
  },
  {
    label: "30 mins",
    value: "30m",
  },
  {
    label: "1 hr",
    value: "1h",
  },
  {
    label: "6 hrs",
    value: "6h",
  },
  {
    label: "12 hrs",
    value: "12h",
  },
  {
    label: "1 day",
    value: "1d",
  },
  {
    label: "3 days",
    value: "3d",
  },
  {
    label: "7 days",
    value: "7d",
  },
  {
    label: "14 days",
    value: "14d",
  },
  {
    label: "30 days",
    value: "30d",
  },
  {
    label: "1 year",
    value: "365d",
  },
];

const defaultPeriod = "7d";
const defaultPeriodMs = parse(defaultPeriod);
if (!defaultPeriodMs) {
  throw new Error("Invalid default period");
}

export const timeFilters = ({
  period,
  from,
  to,
}: {
  period?: string;
  from?: string | number;
  to?: string | number;
}): { period?: string; from?: Date; to?: Date; isDefault: boolean } => {
  if (period) {
    return { period, isDefault: period === defaultPeriod };
  }

  if (from && to) {
    return {
      from: typeof from === "string" ? dateFromString(from) : new Date(from),
      to: typeof to === "string" ? dateFromString(to) : new Date(to),
      isDefault: false,
    };
  }

  if (from) {
    const fromDate = typeof from === "string" ? dateFromString(from) : new Date(from);

    return {
      from: fromDate,
      isDefault: false,
    };
  }

  if (to) {
    const toDate = typeof to === "string" ? dateFromString(to) : new Date(to);

    return {
      to: toDate,
      isDefault: false,
    };
  }

  return {
    period: defaultPeriod,
    isDefault: true,
  };
};

export function TimeFilter() {
  const { value, del } = useSearchParams();

  const { period, from, to } = timeFilters({
    period: value("period"),
    from: value("from"),
    to: value("to"),
  });

  const rangeType = from && to ? "range" : from ? "from" : to ? "to" : "period";
  let valueLabel: ReactNode;
  switch (rangeType) {
    case "period":
      valueLabel = timePeriods.find((t) => t.value === period)?.label ?? period ?? defaultPeriod;
      break;
    case "range":
      valueLabel = (
        <span>
          <DateTime date={from!} includeTime includeSeconds /> –{" "}
          <DateTime date={to!} includeTime includeSeconds />
        </span>
      );
      break;
    case "from":
      valueLabel = <DateTime date={from!} includeTime includeSeconds />;
      break;
    case "to":
      valueLabel = <DateTime date={to!} includeTime includeSeconds />;
      break;
  }

  let label =
    rangeType === "range" || rangeType === "period"
      ? "Created"
      : rangeType === "from"
      ? "Created after"
      : "Created before";

  return (
    <FilterMenuProvider>
      {() => (
        <TimeDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter label={label} value={valueLabel} removable={false} />
            </Ariakit.Select>
          }
          period={period}
          from={from}
          to={to}
        />
      )}
    </FilterMenuProvider>
  );
}

export function TimeDropdown({
  trigger,
  period,
  from,
  to,
}: {
  trigger: ReactNode;
  period?: string;
  from?: Date;
  to?: Date;
}) {
  const [open, setOpen] = useState<boolean | undefined>();
  const { replace } = useSearchParams();
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);

  const apply = useCallback(() => {
    replace({
      period: undefined,
      cursor: undefined,
      direction: undefined,
      from: fromValue?.getTime().toString(),
      to: toValue?.getTime().toString(),
    });

    setOpen(false);
  }, [fromValue, toValue, replace]);

  const handlePeriodClick = useCallback((period: string) => {
    setFromValue(undefined);
    setToValue(undefined);

    replace({
      period: period,
      cursor: undefined,
      direction: undefined,
      from: undefined,
      to: undefined,
    });

    setOpen(false);
  }, []);

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          return true;
        }}
      >
        <div className="flex flex-col gap-6 p-3">
          <div className="flex flex-col gap-1">
            <Label>Runs created in the last</Label>
            <div className="grid grid-cols-4 gap-2">
              {timePeriods.map((p) => (
                <Button
                  key={p.value}
                  variant="secondary/small"
                  className={
                    p.value === period
                      ? "border-indigo-500 group-hover/button:border-indigo-500"
                      : undefined
                  }
                  onClick={() => handlePeriodClick(p.value)}
                  fullWidth
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label>
                From <span className="text-text-dimmed">(local time)</span>
              </Label>
              <DateField
                label="From time"
                defaultValue={fromValue}
                onValueChange={setFromValue}
                granularity="second"
                showNowButton
                showClearButton
                variant="small"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>
                To <span className="text-text-dimmed">(local time)</span>
              </Label>
              <DateField
                label="To time"
                defaultValue={toValue}
                onValueChange={setToValue}
                granularity="second"
                showNowButton
                showClearButton
                variant="small"
              />
            </div>
            <div className="flex justify-between gap-1 border-t border-grid-bright pt-3">
              <Button
                variant="tertiary/small"
                onClick={() => {
                  setFromValue(from);
                  setToValue(to);
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="secondary/small"
                shortcut={{
                  modifiers: ["mod"],
                  key: "Enter",
                  enabledOnInputElements: true,
                }}
                disabled={!fromValue && !toValue}
                onClick={() => apply()}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
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
