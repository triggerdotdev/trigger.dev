import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import type { PrismaClientOrTransaction } from "~/db.server";
import { $replica as defaultReplica, prisma as defaultWriter } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { getMollifierBuffer as defaultGetBuffer } from "./mollifierBuffer.server";

// Discriminated-union resolver used by mutation routes' `findResource`.
// The route builder treats a null return from `findResource` as a 404
// BEFORE the action handler runs (`apiBuilder.server.ts:321`), so we
// must check BOTH the PG canonical store and the mollifier buffer here
// — otherwise a buffered run can't be cancelled / mutated even though
// the underlying mutateWithFallback flow would handle it correctly.
//
// (Regression: before extracting this helper the cancel route had
// `findResource: async () => null`, which made every cancel 404 before
// the action ran. The helper makes the lookup unit-testable.)
export type ResolvedRunForMutation =
  | { source: "pg"; friendlyId: string }
  | { source: "buffer"; friendlyId: string };

type PrismaTaskRunFindFirst = {
  taskRun: {
    findFirst(args: {
      where: { friendlyId: string; runtimeEnvironmentId: string };
      select: { friendlyId: true };
    }): Promise<{ friendlyId: string } | null>;
  };
};

export type ResolveRunForMutationDeps = {
  prismaReplica?: PrismaTaskRunFindFirst;
  prismaWriter?: PrismaTaskRunFindFirst;
  getBuffer?: () => MollifierBuffer | null;
};

export async function resolveRunForMutation(input: {
  runParam: string;
  environmentId: string;
  organizationId: string;
  deps?: ResolveRunForMutationDeps;
}): Promise<ResolvedRunForMutation | null> {
  const replica = input.deps?.prismaReplica ?? defaultReplica;
  const writer = input.deps?.prismaWriter ?? defaultWriter;
  const getBuffer = input.deps?.getBuffer ?? defaultGetBuffer;

  const pgRun = await runStore.findRun(
    { friendlyId: input.runParam, runtimeEnvironmentId: input.environmentId },
    { select: { friendlyId: true } },
    replica as PrismaClientOrTransaction
  );
  if (pgRun) return { source: "pg", friendlyId: pgRun.friendlyId };

  const buffer = getBuffer();

  if (buffer) {
    const entry = await buffer.getEntry(input.runParam);
    if (
      entry &&
      entry.envId === input.environmentId &&
      entry.orgId === input.organizationId
    ) {
      return { source: "buffer", friendlyId: input.runParam };
    }
  }

  // Replica + buffer both missed. Before declaring "not found" (which the
  // route builder converts to a hard 404 *before* the action handler runs,
  // so the downstream `mutateWithFallback` writer-recovery never gets a
  // chance to fire), do one final probe against the writer. This catches
  // two cases:
  //   1. Replica lag on a freshly-created PG row.
  //   2. A buffered run that materialised in the window between the
  //      replica read and our buffer check (the entry was ack'd and the
  //      hash is mid-grace-TTL but our getEntry returned null due to
  //      lookup-by-friendlyId timing).
  // Without this, the resolver returns null in degraded states that the
  // downstream mutateWithFallback flow would otherwise handle correctly.
  const writerRun = await runStore.findRun(
    { friendlyId: input.runParam, runtimeEnvironmentId: input.environmentId },
    { select: { friendlyId: true } },
    writer as PrismaClientOrTransaction
  );
  if (writerRun) return { source: "pg", friendlyId: writerRun.friendlyId };

  return null;
}
