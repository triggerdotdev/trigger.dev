import type { TaskRun } from "@trigger.dev/database";
import type { SyntheticRun } from "./readFallback.server";

export type SyntheticReplayTaskRun = TaskRun & {
  project: { slug: string; organization: { slug: string } };
  runtimeEnvironment: { slug: string };
};

// Adapt a buffered-run snapshot into the TaskRun-shaped input that
// `ReplayTaskRunService.call` expects. ReplayTaskRunService builds the
// new run's traceparent as `00-${existingTaskRun.traceId}-${existingTaskRun.spanId}-01`
// without guarding for undefined, so a synthetic with missing traceId
// or spanId (older snapshots — both fields are documented optional on
// `SyntheticRun`) would produce `00-undefined-undefined-01`, an invalid
// W3C traceparent that OTel silently drops, severing the replay's trace
// link to the original run.
//
// Returns null when those fields are missing — the caller surfaces this
// as "Run not found" so the customer retries once the drainer has
// materialised the PG row, where traceId/spanId are guaranteed present.
export function buildSyntheticReplayTaskRun(args: {
  synthetic: SyntheticRun;
  envRow: {
    slug: string;
    project: { slug: string; organization: { slug: string } };
  };
}): SyntheticReplayTaskRun | null {
  const { synthetic, envRow } = args;
  if (!synthetic.traceId || !synthetic.spanId) return null;
  return {
    // The double `as unknown as TaskRun` cast is load-bearing — a direct
    // `synthetic as TaskRun` won't compile. `SyntheticRun` carries the
    // subset of fields that `ReplayTaskRunService.call` actually reads
    // (the contract is enumerated on the SyntheticRun type comment in
    // readFallback.server.ts), but its shape is not structurally
    // assignable to the full Prisma `TaskRun` row: optional vs required
    // fields diverge, several PG columns (number, batchId variants,
    // status enum widening) are deliberately absent or narrower on the
    // synthetic. Routing it through `unknown` is the explicit "we know
    // this is a subset, we've audited which fields are read" signal,
    // and the traceId/spanId guard above prevents the only field
    // ReplayTaskRunService consumes that would corrupt downstream
    // behaviour (the OTel traceparent) when undefined.
    ...(synthetic as unknown as TaskRun),
    project: {
      slug: envRow.project.slug,
      organization: { slug: envRow.project.organization.slug },
    },
    runtimeEnvironment: { slug: envRow.slug },
  };
}
