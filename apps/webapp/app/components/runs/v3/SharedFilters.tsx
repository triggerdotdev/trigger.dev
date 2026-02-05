import * as Ariakit from "@ariakit/react";
import type { RuntimeEnvironment } from "@trigger.dev/database";
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subWeeks
} from "date-fns";
import parse from "parse-duration";
import { startTransition, useCallback, useEffect, useState, type ReactNode } from "react";
import simplur from "simplur";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { DateTimePicker } from "~/components/primitives/DateTimePicker";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import { ComboboxProvider, SelectPopover, SelectProvider } from "~/components/primitives/Select";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type ShortcutDefinition } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { organizationBillingPath } from "~/utils/pathBuilder";
import { Button, LinkButton } from "../../primitives/Buttons";
import { filterIcon } from "./RunFilters";

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
    label: "5 days",
    value: "5d",
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
  }
];

const timeUnits = [
  { label: "minutes", value: "m", singular: "minute", shortLabel: "mins" },
  { label: "hours", value: "h", singular: "hour", shortLabel: "hours" },
  { label: "days", value: "d", singular: "day", shortLabel: "days" },
];

// Parse a period string (e.g., "90m", "2h", "7d") into value and unit
function parsePeriodString(period: string): { value: number; unit: string } | null {
  const match = period.match(/^(\d+)([mhd])$/);
  if (match) {
    return { value: parseInt(match[1], 10), unit: match[2] };
  }
  return null;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Convert a period string to days using parse-duration
function periodToDays(period: string): number {
  const ms = parse(period);
  if (!ms) return 0;
  return ms / MS_PER_DAY;
}

// Calculate the number of days a date range spans from now
function dateRangeToDays(from?: Date): number {
  if (!from) return 0;
  const now = new Date();
  return Math.ceil((now.getTime() - from.getTime()) / MS_PER_DAY);
}

const DEFAULT_PERIOD = "7d";
const defaultPeriodMs = parse(DEFAULT_PERIOD);
if (!defaultPeriodMs) {
  throw new Error("Invalid default period");
}

type TimeRangeType = "period" | "range" | "from" | "to";

export const timeFilters = ({
  period,
  from,
  to,
  defaultPeriod = DEFAULT_PERIOD,
  labelName = "Created",
}: {
  period?: string;
  from?: string | number;
  to?: string | number;
  defaultPeriod?: string;
  labelName?: string;
}): {
  period?: string;
  from?: Date;
  to?: Date;
  isDefault: boolean;
  rangeType: TimeRangeType;
  label: string;
  valueLabel: ReactNode;
} => {
  if (period) {
    return {
      period,
      isDefault: period === defaultPeriod,
      ...timeFilterRenderValues({ period, labelName }),
    };
  }

  if (from && to) {
    const fromDate = typeof from === "string" ? dateFromString(from) : new Date(from);
    const toDate = typeof to === "string" ? dateFromString(to) : new Date(to);
    return {
      from: fromDate,
      to: toDate,
      isDefault: false,
      ...timeFilterRenderValues({ from: fromDate, to: toDate, labelName }),
    };
  }

  if (from) {
    const fromDate = typeof from === "string" ? dateFromString(from) : new Date(from);

    return {
      from: fromDate,
      isDefault: false,
      ...timeFilterRenderValues({ from: fromDate, labelName }),
    };
  }

  if (to) {
    const toDate = typeof to === "string" ? dateFromString(to) : new Date(to);

    return {
      to: toDate,
      isDefault: false,
      ...timeFilterRenderValues({ to: toDate, labelName }),
    };
  }

  return {
    period: defaultPeriod,
    isDefault: true,
    ...timeFilterRenderValues({ period: defaultPeriod, labelName }),
  };
};

export function timeFilterRenderValues({
  from,
  to,
  period,
  defaultPeriod = DEFAULT_PERIOD,
  labelName = "Created",
}: {
  from?: Date;
  to?: Date;
  period?: string;
  defaultPeriod?: string;
  labelName?: string;
}) {
  const rangeType: TimeRangeType = from && to ? "range" : from ? "from" : to ? "to" : "period";

  let valueLabel: ReactNode;
  switch (rangeType) {
    case "period": {
      // First check if it's a preset period
      const preset = timePeriods.find((t) => t.value === period);
      if (preset) {
        valueLabel = preset.label;
      } else if (period) {
        // Parse custom period and format nicely (e.g., "90m" -> "90 mins")
        const parsed = parsePeriodString(period);
        if (parsed) {
          const unit = timeUnits.find((u) => u.value === parsed.unit);
          if (unit) {
            valueLabel = `${parsed.value} ${parsed.value === 1 ? unit.singular : unit.label}`;
          } else {
            valueLabel = period;
          }
        } else {
          valueLabel = period;
        }
      } else {
        valueLabel = defaultPeriod;
      }
      break;
    }
    case "range":
      {
        //If the day is the same, only show the time for the `to` date
        const isSameDay = from && to && from.getDate() === to.getDate() && from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();

        valueLabel = (
          <span>
            <DateTime date={from!} includeTime includeSeconds /> –{" "}
            <DateTime date={to!} includeTime includeSeconds includeDate={!isSameDay} />
          </span>
        );
      }
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
      ? labelName
      : rangeType === "from"
        ? `${labelName} after`
        : `${labelName} before`;

  return { label, valueLabel, rangeType };
}

/** Values passed to onApply callback when a time filter is applied */
export interface TimeFilterApplyValues {
  period?: string;
  from?: string;
  to?: string;
}

export interface TimeFilterProps {
  defaultPeriod?: string;
  period?: string;
  from?: string;
  to?: string;
  /** Label name used in the filter display, defaults to "Created" */
  labelName?: string;
  hideLabel?: boolean;
  applyShortcut?: ShortcutDefinition | undefined;
  /** Callback when the user applies a time filter selection, receives the applied values */
  onValueChange?: (values: TimeFilterApplyValues) => void;
  /** When set an upgrade message will be shown if you select a period further back than this number of days */
  maxPeriodDays?: number;
}

export function TimeFilter({
  defaultPeriod,
  period,
  from,
  to,
  labelName = "Created",
  hideLabel = false,
  applyShortcut,
  onValueChange,
  maxPeriodDays,
}: TimeFilterProps = {}) {
  const { value } = useSearchParams();
  const periodValue = period ?? value("period");
  const fromValue = from ?? value("from");
  const toValue = to ?? value("to");

  const constrained = timeFilters({
    period: periodValue,
    from: fromValue,
    to: toValue,
    defaultPeriod,
    labelName,
  });

  return (
    <FilterMenuProvider>
      {() => (
        <TimeDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label={hideLabel ? undefined : constrained.label}
                icon={filterIcon("period")}
                value={constrained.valueLabel}
                removable={false}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          period={constrained.period}
          from={constrained.from}
          to={constrained.to}
          defaultPeriod={defaultPeriod}
          labelName={labelName}
          applyShortcut={applyShortcut}
          onValueChange={onValueChange}
          maxPeriodDays={maxPeriodDays}
        />
      )}
    </FilterMenuProvider>
  );
}

// Get initial custom duration state from a period string
function getInitialCustomDuration(period?: string): { value: string; unit: string } {
  if (period) {
    const parsed = parsePeriodString(period);
    if (parsed) {
      return { value: parsed.value.toString(), unit: parsed.unit };
    }
  }
  return { value: "", unit: "m" };
}

type SectionType = "duration" | "dateRange";

export function TimeDropdown({
  trigger,
  period,
  from,
  to,
  defaultPeriod = DEFAULT_PERIOD,
  labelName = "Created",
  applyShortcut,
  onApply,
  onValueChange,
  maxPeriodDays,
}: {
  trigger: ReactNode;
  period?: string;
  from?: Date;
  to?: Date;
  defaultPeriod?: string;
  labelName?: string;
  applyShortcut?: ShortcutDefinition | undefined;
  onApply?: (values: TimeFilterApplyValues) => void;
  /** When provided, the component operates in controlled mode and skips URL navigation */
  onValueChange?: (values: TimeFilterApplyValues) => void;
  /** When set an upgrade message will be shown if you select a period further back than this number of days */
  maxPeriodDays?: number;
}) {
  const organization = useOptionalOrganization();
  const [open, setOpen] = useState<boolean | undefined>();
  const { replace } = useSearchParams();
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);

  // Section selection state: "duration" or "dateRange"
  const initialSection: SectionType = from || to ? "dateRange" : "duration";
  const [activeSection, setActiveSection] = useState<SectionType>(initialSection);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [selectedQuickDate, setSelectedQuickDate] = useState<string | null>(null);

  // Selection state: preset value or "custom"
  const initialCustom = getInitialCustomDuration(period);
  const isInitialCustom =
    period && !timePeriods.some((p) => p.value === period) && initialCustom.value !== "";
  const [selectedPeriod, setSelectedPeriod] = useState<string>(
    isInitialCustom ? "custom" : period ?? defaultPeriod
  );

  // Custom duration state
  const [customValue, setCustomValue] = useState(initialCustom.value);
  const [customUnit, setCustomUnit] = useState(initialCustom.unit);

  // Sync state when props change
  useEffect(() => {
    const parsed = getInitialCustomDuration(period);
    setCustomValue(parsed.value);
    setCustomUnit(parsed.unit);

    const isCustom = period && !timePeriods.some((p) => p.value === period) && parsed.value !== "";
    setSelectedPeriod(isCustom ? "custom" : period ?? defaultPeriod);
    setActiveSection(from || to ? "dateRange" : "duration");
  }, [period, from, to, defaultPeriod]);

  const isCustomDurationValid = (() => {
    const value = parseInt(customValue, 10);
    return !isNaN(value) && value > 0;
  })();

  // Calculate if the current selection exceeds maxPeriodDays
  const exceedsMaxPeriod = (() => {
    if (!maxPeriodDays) return false;

    if (activeSection === "duration") {
      const periodToCheck = selectedPeriod === "custom" ? `${customValue}${customUnit}` : selectedPeriod;
      if (!periodToCheck) return false;
      return periodToDays(periodToCheck) > maxPeriodDays;
    } else {
      // For date range, check if fromValue is further back than maxPeriodDays
      return dateRangeToDays(fromValue) > maxPeriodDays;
    }
  })();

  const applySelection = useCallback(() => {
    setValidationError(null);

    if (exceedsMaxPeriod) {
      setValidationError(`Your plan allows a maximum of ${maxPeriodDays} days. Upgrade for longer retention.`);
      return;
    }

    if (activeSection === "duration") {
      // Validate custom duration
      if (selectedPeriod === "custom" && !isCustomDurationValid) {
        setValidationError("Please enter a valid custom duration");
        return;
      }

      let periodToApply = selectedPeriod;
      if (selectedPeriod === "custom") {
        periodToApply = `${customValue}${customUnit}`;
      }

      const values: TimeFilterApplyValues = { period: periodToApply, from: undefined, to: undefined };

      if (onValueChange) {
        // Controlled mode - just call the handler
        onValueChange(values);
      } else {
        // URL mode - navigate
        replace({
          period: periodToApply,
          cursor: undefined,
          direction: undefined,
          from: undefined,
          to: undefined,
        });
      }

      setFromValue(undefined);
      setToValue(undefined);
      setOpen(false);
      onApply?.(values);
    } else {
      // Validate date range
      if (!fromValue && !toValue) {
        setValidationError("Please specify at least one date");
        return;
      }

      if (fromValue && toValue && fromValue > toValue) {
        setValidationError("From date must be before To date");
        return;
      }

      const fromStr = fromValue?.getTime().toString();
      const toStr = toValue?.getTime().toString();

      const values: TimeFilterApplyValues = { period: undefined, from: fromStr, to: toStr };

      if (onValueChange) {
        // Controlled mode - just call the handler
        onValueChange(values);
      } else {
        // URL mode - navigate
        replace({
          period: undefined,
          cursor: undefined,
          direction: undefined,
          from: fromStr,
          to: toStr,
        });
      }

      setOpen(false);
      onApply?.(values);
    }
  }, [
    activeSection,
    selectedPeriod,
    isCustomDurationValid,
    customValue,
    customUnit,
    fromValue,
    toValue,
    replace,
    onApply,
    onValueChange,
    exceedsMaxPeriod,
    maxPeriodDays
  ]);

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          return true;
        }}
      >
        <div className="flex flex-col gap-4 p-3">
          {/* Duration section */}
          <div
            onClick={() => {
              setActiveSection("duration");
              setValidationError(null);
              setSelectedQuickDate(null);
            }}
            className="flex cursor-pointer gap-3 rounded-md pb-3"
          >
            <RadioButtonCircle checked={activeSection === "duration"} />
            <div className="flex flex-1 flex-col gap-1">
              <Label
                className={cn(
                  "mb-2 transition-colors",
                  activeSection === "duration" && "text-indigo-500"
                )}
              >
                {labelName} in the last
              </Label>
              <div className="grid grid-cols-4 gap-2">
                {/* Custom duration row */}
                <div
                  className={cn(
                    "col-span-4 flex h-[1.8rem] w-full items-center gap-2 rounded border bg-charcoal-750 py-0.5 pl-0 pr-2 transition-colors",
                    activeSection === "duration" && selectedPeriod === "custom"
                      ? "border-indigo-500 "
                      : "border-charcoal-650 hover:border-charcoal-600",
                    validationError &&
                    activeSection === "duration" &&
                    selectedPeriod === "custom" &&
                    "border-error"
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Custom"
                    value={customValue}
                    autoFocus
                    onChange={(e) => {
                      setCustomValue(e.target.value);
                      setSelectedPeriod("custom");
                      setActiveSection("duration");
                      setValidationError(null);
                    }}
                    onFocus={() => {
                      setSelectedPeriod("custom");
                      setActiveSection("duration");
                      setValidationError(null);
                    }}
                    className="h-full w-full translate-y-px border-none bg-transparent py-0 pl-2 pr-0 text-xs leading-none text-text-bright outline-none placeholder:text-text-dimmed focus:outline-none focus:ring-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <div className="flex items-center gap-2">
                    {timeUnits.map((unit) => (
                      <button
                        key={unit.value}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCustomUnit(unit.value);
                          setSelectedPeriod("custom");
                          setActiveSection("duration");
                          setValidationError(null);
                        }}
                        className={cn(
                          "text-xs transition-colors",
                          customUnit === unit.value
                            ? "text-indigo-500"
                            : "text-text-dimmed hover:text-text-bright"
                        )}
                      >
                        {unit.shortLabel}
                      </button>
                    ))}
                  </div>
                </div>
                {timePeriods.map((p) => {
                  const parsed = parsePeriodString(p.value);
                  return (
                    <Button
                      key={p.value}
                      variant="secondary/small"
                      className={
                        activeSection === "duration" && p.value === selectedPeriod
                          ? "border-indigo-500 group-hover/button:border-indigo-500"
                          : undefined
                      }
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setActiveSection("duration");
                        setSelectedPeriod(p.value);
                        if (parsed) {
                          setCustomValue(parsed.value.toString());
                          setCustomUnit(parsed.unit);
                        }
                        setValidationError(null);
                      }}
                      fullWidth
                      type="button"
                    >
                      {p.label}
                    </Button>
                  );
                })}
              </div>
              {validationError && activeSection === "duration" && selectedPeriod === "custom" && (
                <p className="mt-1 text-xs text-error">{validationError}</p>
              )}
            </div>
          </div>

          {/* Date range section */}
          <div
            onClick={() => {
              setActiveSection("dateRange");
              setValidationError(null);
            }}
            className="flex cursor-pointer gap-3"
          >
            <RadioButtonCircle checked={activeSection === "dateRange"} />
            <div className="flex flex-1 flex-col">
              <Label
                className={cn(
                  "mb-3 transition-colors",
                  activeSection === "dateRange" && "text-indigo-500"
                )}
              >
                Or specify exact time range{" "}
                <span
                  className={cn(
                    "transition-colors",
                    activeSection === "dateRange" ? "text-indigo-500" : "text-text-dimmed"
                  )}
                >
                  (in local time)
                </span>
              </Label>
              <div className="-ml-8 mb-2" onClick={(e) => e.stopPropagation()}>
                <DateTimePicker
                  label="From"
                  value={fromValue}
                  onChange={(value) => {
                    setFromValue(value);
                    setActiveSection("dateRange");
                    setValidationError(null);
                    setSelectedQuickDate(null);
                  }}
                  showSeconds
                  showNowButton
                  showClearButton
                  showInlineLabel
                />
              </div>
              <div onClick={(e) => e.stopPropagation()} className="-ml-8">
                <DateTimePicker
                  label="To"
                  value={toValue}
                  onChange={(value) => {
                    setToValue(value);
                    setActiveSection("dateRange");
                    setValidationError(null);
                    setSelectedQuickDate(null);
                  }}
                  showSeconds
                  showNowButton
                  showClearButton
                  showInlineLabel
                />
              </div>
              {/* Quick select date ranges */}
              <div className="mt-2 grid grid-cols-2 gap-2" onClick={(e) => e.stopPropagation()}>
                <QuickDateButton
                  label="Yesterday"
                  isActive={selectedQuickDate === "yesterday"}
                  onClick={() => {
                    const yesterday = subDays(new Date(), 1);
                    setFromValue(startOfDay(yesterday));
                    setToValue(endOfDay(yesterday));
                    setActiveSection("dateRange");
                    setValidationError(null);
                    setSelectedQuickDate("yesterday");
                  }}
                />
                <QuickDateButton
                  label="Today"
                  isActive={selectedQuickDate === "today"}
                  onClick={() => {
                    const today = new Date();
                    setFromValue(startOfDay(today));
                    setToValue(endOfDay(today));
                    setActiveSection("dateRange");
                    setValidationError(null);
                    setSelectedQuickDate("today");
                  }}
                />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                <QuickDateButton
                  label="This week"
                  isActive={selectedQuickDate === "thisWeek"}
                  onClick={() => {
                    const now = new Date();
                    setFromValue(startOfWeek(now, { weekStartsOn: 1 }));
                    setToValue(endOfWeek(now, { weekStartsOn: 1 }));
                    setActiveSection("dateRange");
                    setValidationError(null);
                    setSelectedQuickDate("thisWeek");
                  }}
                />
                <QuickDateButton
                  label="Last week"
                  isActive={selectedQuickDate === "lastWeek"}
                  onClick={() => {
                    const lastWeek = subWeeks(new Date(), 1);
                    setFromValue(startOfWeek(lastWeek, { weekStartsOn: 1 }));
                    setToValue(endOfWeek(lastWeek, { weekStartsOn: 1 }));
                    setActiveSection("dateRange");
                    setValidationError(null);
                    setSelectedQuickDate("lastWeek");
                  }}
                />
                <QuickDateButton
                  label="This month"
                  isActive={selectedQuickDate === "thisMonth"}
                  onClick={() => {
                    const now = new Date();
                    setFromValue(startOfMonth(now));
                    setToValue(endOfMonth(now));
                    setActiveSection("dateRange");
                    setValidationError(null);
                    setSelectedQuickDate("thisMonth");
                  }}
                />
              </div>
              {validationError && activeSection === "dateRange" && (
                <Paragraph variant="extra-small" className="mt-2 text-error">
                  {validationError}
                </Paragraph>
              )}
            </div>
          </div>

          {/* Upgrade callout when exceeding maxPeriodDays */}
          {exceedsMaxPeriod && organization && (
            <Callout
              variant="pricing"
              cta={<LinkButton variant="primary/small" to={organizationBillingPath({ slug: organization.slug })}>Upgrade</LinkButton>}
              className="items-center"
            >
              {simplur`Your plan allows a maximum of ${maxPeriodDays} day[|s].`}
            </Callout>
          )}

          {/* Action buttons */}
          <div className="flex justify-between gap-1 border-t border-grid-bright px-0 pt-3">
            <Button
              variant="tertiary/small"
              onClick={(e) => {
                e.preventDefault();
                setFromValue(from);
                setToValue(to);
                setValidationError(null);
                setOpen(false);
              }}
              type="button"
            >
              Cancel
            </Button>
            <Button
              variant="primary/small"
              shortcut={applyShortcut ? applyShortcut : {
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={(e) => {
                e.preventDefault();
                applySelection();
              }}
              type="button"
              disabled={exceedsMaxPeriod}
            >
              Apply
            </Button>
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

export function dateFromString(value: string | undefined | null): Date | undefined {
  if (!value) return;

  // Only treat as timestamp if the string is purely numeric
  if (/^\d+$/.test(value)) {
    return new Date(parseInt(value));
  }

  return new Date(value);
}

function QuickDateButton({
  label,
  onClick,
  isActive,
}: {
  label: string;
  onClick: () => void;
  isActive?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="secondary/small"
      onClick={onClick}
      fullWidth
      className={isActive ? "border-indigo-500 group-hover/button:border-indigo-500" : undefined}
    >
      {label}
    </Button>
  );
}
