import { BatchId, generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import {
  resolveRunIdMintKind as defaultResolveRunIdMintKind,
  type RunIdMintKind,
} from "~/v3/engineVersion.server";
import { resolveInheritedMintKind } from "~/v3/runOpsMigration/resolveInheritedMintKind.server";

type ResolveDeps = {
  resolveRunIdMintKind: typeof defaultResolveRunIdMintKind;
};

const defaultDeps: ResolveDeps = {
  resolveRunIdMintKind: defaultResolveRunIdMintKind,
};

export function batchIdForMintKind(kind: RunIdMintKind): { id: string; friendlyId: string } {
  if (kind === "ksuid") {
    const id = generateKsuidId();
    return { id, friendlyId: BatchId.toFriendlyId(id) };
  }
  return BatchId.generate();
}

export async function resolveBatchMintKind(args: {
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown };
  parentRunFriendlyId?: string;
  deps?: Partial<ResolveDeps>;
}): Promise<RunIdMintKind> {
  const deps = { ...defaultDeps, ...args.deps };
  return args.parentRunFriendlyId
    ? resolveInheritedMintKind(args.parentRunFriendlyId)
    : deps.resolveRunIdMintKind({
        organizationId: args.environment.organizationId,
        id: args.environment.id,
        orgFeatureFlags: args.environment.orgFeatureFlags,
      });
}

export async function mintBatchFriendlyId(args: {
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown };
  parentRunFriendlyId?: string;
  deps?: Partial<ResolveDeps>;
}): Promise<{ id: string; friendlyId: string }> {
  return batchIdForMintKind(await resolveBatchMintKind(args));
}
