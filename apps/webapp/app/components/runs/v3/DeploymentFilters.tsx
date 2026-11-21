import { CalendarIcon, Squares2X2Icon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { GitBranchIcon } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { isCalendarDay } from "~/components/deployments/deployActivityDays";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button } from "~/components/primitives/Buttons";
import { useLocales } from "~/components/primitives/LocaleProvider";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { v3EnvironmentPath } from "~/utils/pathBuilder";
import { type Option, PermanentSelectFilter } from "./BulkActionFilters";
import {
  type DeploymentDisplayStatus,
  DeploymentStatus,
  deploymentStatuses,
  deploymentStatusTitle,
} from "./DeploymentStatus";

const multi = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => (typeof value === "string" ? [value] : value), item.array().optional());

export const DeploymentListSearchParams = z.object({
  statuses: multi(
    z.custom<DeploymentDisplayStatus>((value) =>
      deploymentStatuses.includes(value as DeploymentDisplayStatus)
    )
  ),
  branches: multi(z.string()),
  search: z.string().optional(),
  /** Set by a click on the activity grid. A value that isn't a day is ignored on its own. */
  day: z.string().refine(isCalendarDay).optional().catch(undefined),
});

/** What resources/…/deployments/branches returns. */
type BranchesResponse = { branches: string[] };

const statusOptions: Option[] = deploymentStatuses.map((status) => ({
  value: status,
  title: deploymentStatusTitle(status, false),
  render: <DeploymentStatus status={status} isBuilt={false} />,
}));

/**
 * The branches come from every deployment in the environment, so they load when the menu opens
 * rather than with the list (which polls). A plain fetch, not a fetcher: the list's polling would
 * reload a fetcher along with the page. Applied branches are listed right away.
 */
function BranchFilter() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { values } = useSearchParams();
  const resource = `/resources${v3EnvironmentPath(organization, project, environment)}/deployments/branches`;
  const [loaded, setLoaded] = useState<{ resource: string; branches: string[] }>();
  const loading = useRef(false);
  const fetched = loaded?.resource === resource ? loaded.branches : undefined;
  const branches = [...new Set([...values("branches"), ...(fetched ?? [])])].sort();

  const load = () => {
    if (loading.current) return;
    loading.current = true;
    fetch(resource)
      .then((response) => (response.ok ? (response.json() as Promise<BranchesResponse>) : null))
      .then((data) => setLoaded({ resource, branches: data?.branches ?? [] }))
      .catch(() => setLoaded({ resource, branches: [] }))
      .finally(() => {
        loading.current = false;
      });
  };

  return (
    <PermanentSelectFilter
      paramKey="branches"
      label="Branch"
      icon={<GitBranchIcon className="size-3.5" />}
      options={branches.map((branch) => ({
        value: branch,
        title: branch,
        render: <span className="truncate font-mono">{branch}</span>,
      }))}
      shortcut={{ key: "b" }}
      onOpen={load}
      empty={
        fetched ? (
          "No branches found"
        ) : (
          <span className="flex items-center gap-2">
            <Spinner color="muted" className="size-3.5" /> Loading branches…
          </span>
        )
      }
    />
  );
}

const activityShortcut = { key: "a" };

export function DeploymentFilters({
  showActivity,
  onShowActivity,
}: {
  /** Whether the activity grid is shown above the list, and the switch that changes it. */
  showActivity: boolean;
  onShowActivity: (show: boolean) => void;
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const day = searchParams.get("day");
  const { del } = useSearchParams();
  const locales = useLocales();
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("branches") ||
    searchParams.has("search") ||
    searchParams.has("day");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <SearchInput placeholder="Search version…" resetParams={["page"]} />
      <PermanentSelectFilter
        paramKey="statuses"
        label="Status"
        icon={<StatusIcon className="size-3.5" />}
        options={statusOptions}
        shortcut={{ key: "s" }}
      />
      <BranchFilter />
      <Switch
        variant="secondary/small"
        label={
          <span className="flex items-center gap-1">
            <Squares2X2Icon className="size-3.5 text-text-dimmed" />
            Activity
          </span>
        }
        checked={showActivity}
        shortcut={activityShortcut}
        onCheckedChange={onShowActivity}
      />
      {day && isCalendarDay(day) ? (
        <AppliedFilter
          icon={<CalendarIcon className="size-3.5" />}
          label="Day"
          value={new Date(`${day}T00:00:00Z`).toLocaleDateString(locales, {
            timeZone: "UTC",
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
          removeLabel="Remove the day filter"
          onRemove={() => del(["day", "page"])}
        />
      ) : null}
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
