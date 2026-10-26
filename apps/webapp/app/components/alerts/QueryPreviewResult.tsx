import type { PreviewQueryResponse } from "~/v3/services/alerts/previewQuery.server";

export type QueryPreviewOutcome =
  | { kind: "result"; response: PreviewQueryResponse }
  | { kind: "busy" }
  | { kind: "error"; message: string };

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function QueryPreviewResult({
  outcome,
  detailRows,
}: {
  outcome: QueryPreviewOutcome;
  detailRows: number;
}) {
  if (outcome.kind === "busy") {
    return <p className="text-xs text-error">Another query is running, try again</p>;
  }
  if (outcome.kind === "error") {
    return <p className="text-xs text-error">{outcome.message}</p>;
  }
  const response = outcome.response;
  if (!response.ok) {
    return <p className="text-xs text-error">{response.reason}</p>;
  }
  const rows = response.rows ?? [];
  const count = response.total ?? rows.length;
  return (
    <div data-testid="query-preview" className="flex flex-col gap-1.5 text-sm text-text-bright">
      {response.mode === "threshold" ? (
        <>
          <p>Current value: {response.value ?? "–"}</p>
          {response.offenders?.length ? (
            <ul className="flex flex-col gap-0.5 text-xs text-text-dimmed">
              {response.offenders.map((offender) => (
                <li key={offender.key} className="flex justify-between gap-2 tabular-nums">
                  <span className="truncate">{offender.key}</span>
                  <span>{offender.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : response.mode === "match" ? (
        <>
          <p>
            {count}
            {response.capped ? "+" : ""} new matching rows in the window
          </p>
          {rows.length ? (
            <ul className="flex flex-col gap-0.5 text-xs text-text-dimmed">
              {rows.slice(0, detailRows).map((row) => (
                <li key={row.id} className="truncate tabular-nums">
                  {Object.entries(row.columns)
                    .map(([column, value]) => `${column}: ${formatCell(value)}`)
                    .join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p>Matching rows in the window: {response.value ?? count}</p>
      )}
      <p className={response.wouldFire ? "text-warning" : "text-text-dimmed"}>
        {response.wouldFire ? "Would fire now" : "Would not fire now"}
      </p>
    </div>
  );
}
