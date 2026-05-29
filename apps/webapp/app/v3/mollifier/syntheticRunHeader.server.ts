import type { SyntheticRun } from "./readFallback.server";

// Synthesise the run-detail page's `run` header shape (the NavBar +
// status badge + Cancel-button gate) from a buffered run snapshot. The
// shape matches `RunPresenter.getRun`'s `runData` — keep this in sync
// when fields are added there.
//
// CANCELED and FAILED state is reflected back from
// `SyntheticRun.cancelledAt` / `status` so terminal buffered runs show
// the correct status in the NavBar + isFinished:true (which collapses
// the Cancel button on the page header) before the drainer materialises
// the PG row. This mirrors what `buildSyntheticSpanRun` does for the
// right-side details panel — the SyntheticRun.cancelledAt contract
// comment in readFallback.server.ts names this exact UI surface.
//
// FAILED status maps to `SYSTEM_FAILURE` to match the drainer's
// non-retryable terminal path, which is what `buildSyntheticSpanRun`
// uses too. Symmetric across the header + span-detail panel so an
// admin doesn't see "Pending" + "FAILED" simultaneously on the same
// run.
export function buildSyntheticRunHeader(args: {
  run: SyntheticRun;
  environment: {
    id: string;
    organizationId: string;
    type: "PRODUCTION" | "DEVELOPMENT" | "STAGING" | "PREVIEW";
    slug: string;
  };
}) {
  const { run, environment } = args;
  const isCancelled = run.status === "CANCELED";
  const isFailed = run.status === "FAILED";

  return {
    // `id` mirrors RunPresenter.getRun's runData (the PG path), which
    // is the internal cuid — not the friendlyId. SyntheticRun.id is
    // already the cuid (RunId.fromFriendlyId(entry.runId) in
    // readFallback.server.ts) so the admin debug tooltip on the run
    // detail page shows the same format for buffered + materialised
    // runs.
    id: run.id,
    number: 1,
    friendlyId: run.friendlyId,
    traceId: run.traceId ?? "",
    spanId: run.spanId ?? "",
    status: isCancelled
      ? ("CANCELED" as const)
      : isFailed
      ? ("SYSTEM_FAILURE" as const)
      : ("PENDING" as const),
    isFinished: isCancelled || isFailed,
    startedAt: null,
    completedAt: run.cancelledAt ?? null,
    logsDeletedAt: null,
    rootTaskRun: null,
    parentTaskRun: null,
    environment: {
      id: environment.id,
      organizationId: environment.organizationId,
      type: environment.type,
      slug: environment.slug,
      userId: undefined,
      userName: undefined,
    },
  };
}
