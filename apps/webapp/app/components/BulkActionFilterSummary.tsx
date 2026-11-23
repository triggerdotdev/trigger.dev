import { z } from "zod";
import {
  filterIcon,
  filterTitle,
  type TaskRunListSearchFilterKey,
  type TaskRunListSearchFilters,
} from "./runs/v3/RunFilters";
import { Paragraph } from "./primitives/Paragraph";
import simplur from "simplur";
import { appliedSummary, dateFromString, timeFilterRenderValues } from "./runs/v3/SharedFilters";
import { formatNumber } from "~/utils/numberFormatter";
import { Spinner } from "./primitives/Spinner";
import { ArrowPathIcon, CheckIcon, XCircleIcon } from "@heroicons/react/20/solid";
import { XCircleIcon as XCircleIconOutline } from "@heroicons/react/24/outline";
import { AppliedFilter } from "./primitives/AppliedFilter";
import { runStatusTitle } from "./runs/v3/TaskRunStatus";
import type { TaskRunStatus } from "@trigger.dev/database";

export const BulkActionMode = z.union([z.literal("selected"), z.literal("filter")]);
export type BulkActionMode = z.infer<typeof BulkActionMode>;
export const BulkActionAction = z.union([z.literal("cancel"), z.literal("replay")]);
export type BulkActionAction = z.infer<typeof BulkActionAction>;

export function BulkActionFilterSummary({
  selected,
  final = false,
  mode,
  action,
  filters,
}: {
  selected?: number;
  final?: boolean;
  mode: BulkActionMode;
  action: BulkActionAction;
  filters: TaskRunListSearchFilters;
}) {
  switch (mode) {
    case "selected":
      return (
        <Paragraph variant="small">
          You {!final ? "have " : " "}individually selected {simplur`${selected} run[|s]`} to be{" "}
          <Action action={action} />.
        </Paragraph>
      );
    case "filter": {
      return (
        <div className="flex flex-col gap-2">
          <Paragraph variant="small">
            You {!final ? "have " : " "}selected{" "}
            <span className="text-text-bright">
              {final ? selected : <EstimatedCount count={selected} />}
            </span>{" "}
            runs to be <Action action={action} /> using these filters:
          </Paragraph>
          <BulkActionFilterChips filters={filters} />
        </div>
      );
    }
  }
}

const DEFAULT_RUNS_PERIOD = "7d";
const IGNORED_SUMMARY_KEYS = new Set([
  "cursor",
  "direction",
  "environments",
  "period",
  "from",
  "to",
]);

/** True when the only filter is the default time period, i.e. the runs list is unfiltered. */
export function hasOnlyDefaultFilters(filters: TaskRunListSearchFilters) {
  if (filters.from || filters.to || (filters.period && filters.period !== DEFAULT_RUNS_PERIOD)) {
    return false;
  }
  return Object.entries(filters).every(
    ([key, value]) =>
      IGNORED_SUMMARY_KEYS.has(key) ||
      value === undefined ||
      value === false ||
      (Array.isArray(value) && value.length === 0)
  );
}

export function BulkActionFilterChips({
  filters,
  chipVariant = "minimal/medium",
  timeValue,
}: {
  filters: TaskRunListSearchFilters;
  /** Replaces the time chip's value, e.g. with a shorter range. */
  timeValue?: string;
  /** "minimal/medium" stacks icon chips; "secondary/small" wraps them like the runs list filter bar. */
  chipVariant?: "minimal/medium" | "secondary/small";
}) {
  const { label, valueLabel } = timeFilterRenderValues({
    from: filters.from ? dateFromString(`${filters.from}`) : undefined,
    to: filters.to ? dateFromString(`${filters.to}`) : undefined,
    period: filters.period,
  });
  const hasRunIds = Array.isArray(filters.runId) ? filters.runId.length > 0 : !!filters.runId;

  return (
    <div
      className={
        chipVariant === "minimal/medium" ? "flex flex-col gap-2" : "flex flex-wrap gap-1.5"
      }
    >
      {/* A run ID search without an explicit time applies no period. */}
      {!(hasRunIds && !filters.period && !filters.from && !filters.to) && (
        <AppliedFilter
          variant={chipVariant}
          label={label}
          icon={filterIcon("period")}
          value={timeValue ?? valueLabel}
          removable={false}
        />
      )}
      {Object.entries(filters).map(([key, value]) => {
        if (!value && key !== "period") {
          return null;
        }

        const typedKey = key as TaskRunListSearchFilterKey;

        switch (typedKey) {
          case "cursor":
          case "direction":
          case "environments":
          //We need to handle time differently because we have a default
          case "period":
          case "from":
          case "to": {
            return null;
          }
          case "tasks": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values)}
                removable={false}
              />
            );
          }
          case "versions": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values)}
                removable={false}
              />
            );
          }
          case "statuses": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values.map((v) => runStatusTitle(v as TaskRunStatus)))}
                removable={false}
              />
            );
          }
          case "tags": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values)}
                removable={false}
              />
            );
          }
          case "bulkId": {
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={value}
                removable={false}
              />
            );
          }
          case "rootOnly": {
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={"Root only"}
                icon={filterIcon(key)}
                value={
                  value ? <CheckIcon className="size-4" /> : <XCircleIcon className="size-4" />
                }
                removable={false}
              />
            );
          }
          case "runId": {
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={"Run ID"}
                icon={filterIcon(key)}
                value={value}
                removable={false}
              />
            );
          }
          case "batchId": {
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={"Batch ID"}
                icon={filterIcon(key)}
                value={value}
                removable={false}
              />
            );
          }
          case "scheduleId": {
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={"Schedule ID"}
                icon={filterIcon(key)}
                value={value}
                removable={false}
              />
            );
          }
          case "queues": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values.map((v) => v.replace("task/", "")))}
                removable={false}
              />
            );
          }
          case "regions": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values)}
                removable={false}
              />
            );
          }
          case "machines": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values)}
                removable={false}
              />
            );
          }
          case "errorId": {
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={"Error ID"}
                icon={filterIcon(key)}
                value={value}
                removable={false}
              />
            );
          }
          case "sources": {
            const values = Array.isArray(value) ? value : [`${value}`];
            return (
              <AppliedFilter
                variant={chipVariant}
                key={key}
                label={filterTitle(key)}
                icon={filterIcon(key)}
                value={appliedSummary(values)}
                removable={false}
              />
            );
          }
          default: {
            // Filters parsed from a request carry keys that aren't URL filters (`taskKinds`,
            // set from `sources`). They get no chip.
            typedKey satisfies never;
            return null;
          }
        }
      })}
    </div>
  );
}

function Action({ action }: { action: BulkActionAction }) {
  switch (action) {
    case "cancel":
      return (
        <span>
          <XCircleIconOutline className="mb-0.5 inline-block size-4 text-error" />
          <span className="ml-0.5 text-text-bright">Canceled</span>
        </span>
      );
    case "replay":
      return (
        <span>
          <ArrowPathIcon className="mb-0.5 inline-block size-4 text-blue-400" />
          <span className="ml-0.5 text-text-bright">Replayed</span>
        </span>
      );
  }
}

export function EstimatedCount({ count }: { count?: number }) {
  if (typeof count === "number") {
    return <>~{formatNumber(count)}</>;
  }

  return <Spinner color="blue" className="mx-0.5 -mt-0.5 inline size-3" />;
}
