import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TableBlankRow } from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { NextRunListAppliedFilters } from "~/presenters/v3/NextRunListPresenter.server";
import { v3TestPath, v3TestTaskPath } from "~/utils/pathBuilder";

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
}: {
  isLoading?: boolean;
  filters: NextRunListAppliedFilters;
  colSpan: number;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  if (isLoading) return <TableBlankRow colSpan={colSpan} />;

  const { tasks, from, to, ...otherFilters } = filters;
  const singleTaskFromFilters = filters.tasks.length === 1 ? filters.tasks[0] : null;
  const testPath = singleTaskFromFilters
    ? v3TestTaskPath(organization, project, environment, { taskIdentifier: singleTaskFromFilters })
    : v3TestPath(organization, project, environment);

  if (
    filters.tasks.length === 1 &&
    filters.from === undefined &&
    filters.to === undefined &&
    Object.values(otherFilters).every((filterArray) => filterArray.length === 0)
  ) {
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
