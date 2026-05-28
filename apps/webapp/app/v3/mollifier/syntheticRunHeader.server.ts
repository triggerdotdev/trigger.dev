import type { SyntheticRun } from "./readFallback.server";

// Synthesise the run-detail page's `run` header shape (the NavBar +
// status badge + Cancel-button gate) from a buffered run snapshot. The
// shape matches `RunPresenter.getRun`'s `runData` — keep this in sync
// when fields are added there.
//
// CANCELED state is reflected back from `SyntheticRun.cancelledAt` /
// `status` so that after a buffered-cancel the NavBar shows the run as
// CANCELED + isFinished:true (which collapses the Cancel button) before
// the drainer materialises the PG row. This mirrors what
// `buildSyntheticSpanRun` does for the right-side details panel — the
// SyntheticRun.cancelledAt contract comment in readFallback.server.ts
// names this exact UI surface.
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

  return {
    id: run.friendlyId,
    number: 1,
    friendlyId: run.friendlyId,
    traceId: run.traceId ?? "",
    spanId: run.spanId ?? "",
    status: isCancelled ? ("CANCELED" as const) : ("PENDING" as const),
    isFinished: isCancelled,
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
