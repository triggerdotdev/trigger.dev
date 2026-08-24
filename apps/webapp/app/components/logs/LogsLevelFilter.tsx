import * as Ariakit from "@ariakit/react";
import { IconListTree } from "@tabler/icons-react";
import { type ReactNode } from "react";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import {
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { useSearchParams } from "~/hooks/useSearchParam";
import { appliedSummary } from "~/components/runs/v3/SharedFilters";
import { LogLevel } from "~/components/logs/LogLevel";
import type { LogLevel as LogLevelValue } from "~/presenters/v3/LogsListPresenter.server";

const allLogLevels: { level: LogLevelValue; label: string }[] = [
  { level: "TRACE", label: "Trace" },
  { level: "INFO", label: "Info" },
  { level: "WARN", label: "Warning" },
  { level: "ERROR", label: "Error" },
  { level: "DEBUG", label: "Debug" },
];

// In the future we might add other levels or change which are available
function getAvailableLevels(): typeof allLogLevels {
  return allLogLevels;
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
    <LevelDropdown
      trigger={
        <SelectTrigger
          icon={<IconListTree className="size-4" />}
          variant="secondary/small"
          shortcut={shortcut}
          tooltipTitle="Filter by level"
          className="pl-1.5"
        >
          <span className="ml-1">Level</span>
        </SelectTrigger>
      }
    />
  );
}

function LevelDropdown({ trigger }: { trigger: ReactNode }) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    replace({ levels: values, cursor: undefined, direction: undefined });
  };

  const availableLevels = getAvailableLevels();

  return (
    <SelectProvider value={values("levels")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
        <SelectList>
          {availableLevels.map((item, index) => (
            <SelectItem
              key={item.level}
              value={item.level}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              {/* The same chip the rows use, so the dropdown can't drift from the list */}
              <LogLevel level={item.level} />
              <span className="sr-only">{item.label}</span>
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
    <LevelDropdown
      trigger={
        <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
          <AppliedFilter
            label="Level"
            icon={<IconListTree className="size-4" />}
            value={appliedSummary(levels)}
            onRemove={() => del(["levels", "cursor", "direction"])}
            variant="secondary/small"
          />
        </Ariakit.Select>
      }
    />
  );
}
