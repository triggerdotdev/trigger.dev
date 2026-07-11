import { ownerEngine, RunId, type Residency } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";

type MintKind = "cuid" | "runOpsId";

export type ResolveIdempotencyClientDeps = {
  isSplitEnabled: () => Promise<boolean>;
  fallbackClient: PrismaClientOrTransaction;
  newClient: PrismaClientOrTransaction;
  legacyClient: PrismaClientOrTransaction;
  resolveMintKind: (environment: {
    organizationId: string;
    id: string;
    orgFeatureFlags?: unknown;
  }) => Promise<MintKind>;
  classify?: (id: string) => Residency;
  isMigrated?: (id: string) => Promise<boolean>;
};

export async function resolveIdempotencyDedupClient(
  args: {
    environmentForMint: { organizationId: string; id: string; orgFeatureFlags?: unknown };
    parentRunFriendlyId: string | undefined;
  },
  deps: ResolveIdempotencyClientDeps
): Promise<PrismaClientOrTransaction> {
  if (!(await deps.isSplitEnabled())) {
    return deps.fallbackClient;
  }

  const classify = deps.classify ?? ownerEngine;
  const clientFor = (residency: Residency): PrismaClientOrTransaction =>
    residency === "NEW" ? deps.newClient : deps.legacyClient;

  if (args.parentRunFriendlyId) {
    let parentInternalId: string;
    try {
      parentInternalId = RunId.fromFriendlyId(args.parentRunFriendlyId);
    } catch {
      return deps.fallbackClient;
    }
    let residency: Residency;
    try {
      residency = classify(parentInternalId);
    } catch {
      return deps.fallbackClient;
    }
    if (residency === "LEGACY" && deps.isMigrated && (await deps.isMigrated(parentInternalId))) {
      return deps.newClient;
    }
    return clientFor(residency);
  }

  const kind = await deps.resolveMintKind(args.environmentForMint);
  return clientFor(kind === "runOpsId" ? "NEW" : "LEGACY");
}
