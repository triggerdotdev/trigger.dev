import {
  resolveColumnLayout,
  visibleSmartSources,
  visibleStandardIds,
  type RunColumnId,
  type SmartColumnSource,
} from "~/components/runs/v3/runColumns";

/**
 * Read the runs-list column state (`cols`/`sc`) off the request and resolve the
 * column set the presenter needs to derive its Postgres select. Gates are
 * resolved permissively here because they do not affect the always-selected
 * fields; only the referenced smart-column sources change what is hydrated.
 */
export function getRunColumnsForSelect(request: Request): {
  visibleStandardIds: RunColumnId[];
  smartSources: SmartColumnSource[];
} {
  const url = new URL(request.url);
  const layout = resolveColumnLayout(
    { cols: url.searchParams.getAll("cols"), sc: url.searchParams.getAll("sc") },
    { isManagedCloud: true, isDevelopment: false }
  );

  return {
    visibleStandardIds: visibleStandardIds(layout.visible),
    smartSources: visibleSmartSources(layout.visible),
  };
}
