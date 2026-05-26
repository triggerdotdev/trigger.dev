import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { $replica as defaultReplica } from "~/db.server";
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

export type ResolveRunForMutationDeps = {
  prismaReplica?: {
    taskRun: {
      findFirst(args: {
        where: { friendlyId: string; runtimeEnvironmentId: string };
        select: { friendlyId: true };
      }): Promise<{ friendlyId: string } | null>;
    };
  };
  getBuffer?: () => MollifierBuffer | null;
};

export async function resolveRunForMutation(input: {
  runParam: string;
  environmentId: string;
  organizationId: string;
  deps?: ResolveRunForMutationDeps;
}): Promise<ResolvedRunForMutation | null> {
  const replica = input.deps?.prismaReplica ?? defaultReplica;
  const getBuffer = input.deps?.getBuffer ?? defaultGetBuffer;

  const pgRun = await replica.taskRun.findFirst({
    where: { friendlyId: input.runParam, runtimeEnvironmentId: input.environmentId },
    select: { friendlyId: true },
  });
  if (pgRun) return { source: "pg", friendlyId: pgRun.friendlyId };

  const buffer = getBuffer();
  if (!buffer) return null;

  const entry = await buffer.getEntry(input.runParam);
  if (
    entry &&
    entry.envId === input.environmentId &&
    entry.orgId === input.organizationId
  ) {
    return { source: "buffer", friendlyId: input.runParam };
  }
  return null;
}
