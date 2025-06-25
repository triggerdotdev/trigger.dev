import { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { getRootOnlyFilterPreference } from "~/services/preferences/uiPreferences.server";

export async function getRunFiltersFromRequest(request: Request) {
  const url = new URL(request.url);
  let rootOnlyValue = false;
  if (url.searchParams.has("rootOnly")) {
    rootOnlyValue = url.searchParams.get("rootOnly") === "true";
  } else {
    rootOnlyValue = await getRootOnlyFilterPreference(request);
  }

  const s = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    tasks: url.searchParams.getAll("tasks"),
    period: url.searchParams.get("period") ?? undefined,
    bulkId: url.searchParams.get("bulkId") ?? undefined,
    tags: url.searchParams.getAll("tags").map((t) => decodeURIComponent(t)),
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    rootOnly: rootOnlyValue,
    runId: url.searchParams.get("runId") ?? undefined,
    batchId: url.searchParams.get("batchId") ?? undefined,
    scheduleId: url.searchParams.get("scheduleId") ?? undefined,
  };

  const {
    tasks,
    versions,
    statuses,
    tags,
    period,
    bulkId,
    from,
    to,
    cursor,
    direction,
    runId,
    batchId,
    scheduleId,
  } = TaskRunListSearchFilters.parse(s);

  return {
    tasks,
    versions,
    statuses,
    tags,
    period,
    bulkId,
    from,
    to,
    batchId,
    runIds: runId ? [runId] : undefined,
    scheduleId,
    rootOnly: rootOnlyValue,
    direction: direction,
    cursor: cursor,
  };
}
