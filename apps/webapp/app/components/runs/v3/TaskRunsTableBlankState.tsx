import { ArrowPathIcon, CalendarDaysIcon } from "@heroicons/react/20/solid";
import parse from "parse-duration";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TableBlankRow } from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { NextRunListAppliedFilters } from "~/presenters/v3/NextRunListPresenter.server";
import { v3TestPath, v3TestTaskPath } from "~/utils/pathBuilder";
import { timeFilterRenderValues } from "./SharedFilters";

// The widest preset in the time filter.
const WIDER_PERIOD = "30d";

export function NoRuns({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}

export function BlankState({
  isLoading,
  filters,
  colSpan,
  canWidenPeriod = false,
}: {
  isLoading?: boolean;
  filters: NextRunListAppliedFilters;
  colSpan: number;
  /** Offer a link that reruns the same filters over the widest preset period. */
  canWidenPeriod?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useOptimisticLocation();
  if (isLoading) return <TableBlankRow colSpan={colSpan} />;

  const { tasks, from, to, period, isDefaultPeriod, ...otherFilters } = filters;
  const hasOtherFilters = !Object.values(otherFilters).every(
    (filterArray) => filterArray.length === 0
  );
  const singleTaskFromFilters = filters.tasks.length === 1 ? filters.tasks[0] : null;
  const testPath = singleTaskFromFilters
    ? v3TestTaskPath(organization, project, environment, { taskIdentifier: singleTaskFromFilters })
    : v3TestPath(organization, project, environment);

  const periodLabel = period ? timeFilterRenderValues({ period }).valueLabel : undefined;
  const widenPath =
    canWidenPeriod && period && periodIsShorter(period, WIDER_PERIOD)
      ? widenedPeriodPath(location.pathname, location.search, WIDER_PERIOD)
      : undefined;

  if (periodLabel) {
    const what =
      tasks.length === 1 && !hasOtherFilters
        ? `There are no runs for ${tasks[0]} in the last ${periodLabel}.`
        : tasks.length === 0 && !hasOtherFilters
          ? `There are no runs in the last ${periodLabel}.`
          : `No runs in the last ${periodLabel} match your filters.`;

    return (
      <TableBlankRow colSpan={colSpan}>
        <div className="flex flex-col items-center justify-center gap-4">
          <Paragraph className="w-auto" variant="base/bright">
            {what}
          </Paragraph>
          <div className="flex items-center gap-2">
            {widenPath ? (
              <LinkButton LeadingIcon={CalendarDaysIcon} variant="secondary/medium" to={widenPath}>
                Search the last {timeFilterRenderValues({ period: WIDER_PERIOD }).valueLabel}
              </LinkButton>
            ) : null}
            <LinkButton
              LeadingIcon={BeakerIcon}
              leadingIconClassName="text-tests"
              variant="secondary/medium"
              to={testPath}
            >
              Run a test
            </LinkButton>
          </div>
        </div>
      </TableBlankRow>
    );
  }

  if (filters.tasks.length === 1 && from === undefined && to === undefined && !hasOtherFilters) {
    return (
      <TableBlankRow colSpan={colSpan}>
        <Paragraph className="w-auto" variant="base/bright" spacing>
          There are no runs for {filters.tasks[0]}
        </Paragraph>
      </TableBlankRow>
    );
  }

  return (
    <TableBlankRow colSpan={colSpan}>
      <div className="flex flex-col items-center justify-center gap-6">
        <Paragraph className="w-auto" variant="base/bright">
          No runs match your filters. Try refreshing, modifying your filters or run a test.
        </Paragraph>
        <div className="flex items-center gap-2">
          <Button
            LeadingIcon={ArrowPathIcon}
            variant="secondary/medium"
            onClick={() => {
              window.location.reload();
            }}
          >
            Refresh
          </Button>
          <Paragraph>or</Paragraph>
          <LinkButton
            LeadingIcon={BeakerIcon}
            leadingIconClassName="text-tests"
            variant="secondary/medium"
            to={testPath}
          >
            Run a test
          </LinkButton>
        </div>
      </div>
    </TableBlankRow>
  );
}

function periodIsShorter(period: string, than: string): boolean {
  return (parse(period) ?? Infinity) < (parse(than) ?? 0);
}

// Same filters, a wider period, and back to the first page.
function widenedPeriodPath(pathname: string, search: string, period: string): string {
  const params = new URLSearchParams(search);
  params.delete("from");
  params.delete("to");
  params.delete("cursor");
  params.delete("direction");
  params.set("period", period);
  return `${pathname}?${params.toString()}`;
}
