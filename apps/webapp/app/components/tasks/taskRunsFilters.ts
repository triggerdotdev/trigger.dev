import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { parseFiniteInt } from "~/utils/searchParams";

/**
 * The runs list filters that match what a task page's Runs tab is showing: the task, plus the
 * page's time range and versions when they're set. Links out of the tab (the runs list, a bulk
 * replay) use these so they cover the same runs as the table.
 */
export function taskRunsFilters(
  taskSlug: string,
  searchParams: URLSearchParams
): TaskRunListSearchFilters {
  const versions = searchParams.getAll("versions").filter((version) => version.length > 0);
  return {
    tasks: [taskSlug],
    versions: versions.length > 0 ? versions : undefined,
    period: searchParams.get("period") ?? undefined,
    from: parseFiniteInt(searchParams.get("from")),
    to: parseFiniteInt(searchParams.get("to")),
  };
}
