import * as Ariakit from "@ariakit/react";
import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { type ReactNode, useMemo } from "react";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import {
  ComboBox,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { useSearchParams } from "~/hooks/useSearchParam";
import { FilterMenuProvider, appliedSummary } from "~/components/runs/v3/SharedFilters";
import type { LogLevel } from "~/presenters/v3/LogsListPresenter.server";
import { cn } from "~/utils/cn";

const logLevels: { level: LogLevel; label: string; color: string }[] = [
  { level: "ERROR", label: "Error", color: "text-error" },
  { level: "WARN", label: "Warning", color: "text-warning" },
  { level: "INFO", label: "Info", color: "text-blue-400" },
  { level: "LOG", label: "Log", color: "text-text-dimmed" },
  { level: "DEBUG", label: "Debug", color: "text-charcoal-400" },
  { level: "TRACE", label: "Trace", color: "text-charcoal-500" },
];

function getLevelBadgeColor(level: LogLevel): string {
  switch (level) {
    case "ERROR":
      return "text-error bg-error/10 border-error/20";
    case "WARN":
      return "text-warning bg-warning/10 border-warning/20";
    case "DEBUG":
      return "text-charcoal-400 bg-charcoal-700 border-charcoal-600";
    case "INFO":
      return "text-blue-400 bg-blue-500/10 border-blue-500/20";
    case "TRACE":
      return "text-charcoal-500 bg-charcoal-800 border-charcoal-700";
    case "LOG":
    default:
      return "text-text-dimmed bg-charcoal-750 border-charcoal-700";
  }
}

const shortcut = { key: "l" };

export function LogsLevelFilter() {
  const { values } = useSearchParams();
  const selectedLevels = values("levels");
  const hasLevels = selectedLevels.length > 0 && selectedLevels.some((v) => v !== "");

  if (hasLevels) {
    return <AppliedLevelFilter />;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <LevelDropdown
          trigger={
            <SelectTrigger
              icon={<ExclamationTriangleIcon className="size-4" />}
              variant="secondary/small"
              shortcut={shortcut}
              tooltipTitle="Filter by level"
            >
              Level
            </SelectTrigger>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function LevelDropdown({
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
    replace({ levels: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return logLevels.filter((item) =>
      item.label.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider value={values("levels")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder="Filter by level..." value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.level}
              value={item.level}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <span
                className={cn(
                  "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium uppercase",
                  getLevelBadgeColor(item.level)
                )}
              >
                {item.level}
              </span>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedLevelFilter() {
  const { values, del } = useSearchParams();
  const levels = values("levels");

  if (levels.length === 0 || levels.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <LevelDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Level"
                icon={<ExclamationTriangleIcon className="size-4" />}
                value={appliedSummary(levels)}
                onRemove={() => del(["levels", "cursor", "direction"])}
                variant="secondary/small"
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
