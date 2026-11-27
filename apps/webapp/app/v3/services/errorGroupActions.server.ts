import { Prisma } from "@trigger.dev/database";
import { type PrismaClientOrTransaction, prisma } from "~/db.server";
import { ServiceValidationError } from "./common.server";

type ErrorGroupIdentifier = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  taskIdentifier: string;
  errorFingerprint: string;
};

/** The stored state's revision: its last update, or "none" while the group has no stored state. */
export function errorGroupRevision(state: { updatedAt: Date } | null): string {
  return state ? state.updatedAt.toISOString() : "none";
}

const CHANGED = "The error group was changed by another request. Fetch it again and retry.";

/** Writes only if the stored state is still at `revision`; otherwise throws a 409. */
async function writeAtRevision(
  db: PrismaClientOrTransaction,
  identifier: ErrorGroupIdentifier,
  update: Prisma.ErrorGroupStateUpdateManyMutationInput,
  create: Prisma.ErrorGroupStateUncheckedCreateInput,
  revision: string
) {
  if (revision === "none") {
    try {
      await db.errorGroupState.create({ data: create });
      return;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ServiceValidationError(CHANGED, 409);
      }
      throw error;
    }
  }
  const result = await db.errorGroupState.updateMany({
    where: {
      environmentId: identifier.environmentId,
      taskIdentifier: identifier.taskIdentifier,
      errorFingerprint: identifier.errorFingerprint,
      updatedAt: new Date(revision),
    },
    data: update,
  });
  if (result.count === 0) throw new ServiceValidationError(CHANGED, 409);
}

export class ErrorGroupActions {
  constructor(private readonly _prisma: PrismaClientOrTransaction = prisma) {}

  async resolveError(
    identifier: ErrorGroupIdentifier,
    params: {
      // Nullable: a resolve via an env API key has no acting user, so
      // `resolvedBy` stays null. The dashboard always passes a userId; the
      // API passes the `act.sub` user from a PAT/UAT-exchanged JWT, else null.
      userId?: string | null;
      resolvedInVersion?: string;
    },
    revision?: string
  ) {
    const where = {
      environmentId_taskIdentifier_errorFingerprint: {
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
      },
    };

    const now = new Date();
    const update = {
      status: "RESOLVED" as const,
      resolvedAt: now,
      resolvedInVersion: params.resolvedInVersion ?? null,
      resolvedBy: params.userId ?? null,
      ignoredUntil: null,
      ignoredUntilOccurrenceRate: null,
      ignoredUntilTotalOccurrences: null,
      ignoredAtOccurrenceCount: null,
      ignoredAt: null,
      ignoredReason: null,
      ignoredByUserId: null,
    };
    const create = {
      organizationId: identifier.organizationId,
      projectId: identifier.projectId,
      environmentId: identifier.environmentId,
      taskIdentifier: identifier.taskIdentifier,
      errorFingerprint: identifier.errorFingerprint,
      status: "RESOLVED" as const,
      resolvedAt: now,
      resolvedInVersion: params.resolvedInVersion ?? null,
      resolvedBy: params.userId ?? null,
    };
    if (revision !== undefined) {
      return writeAtRevision(this._prisma, identifier, update, create, revision);
    }

    return this._prisma.errorGroupState.upsert({ where, update, create });
  }

  async ignoreError(
    identifier: ErrorGroupIdentifier,
    params: {
      userId?: string | null;
      duration?: number;
      occurrenceRateThreshold?: number;
      totalOccurrencesThreshold?: number;
      occurrenceCountAtIgnoreTime?: number;
      reason?: string;
    },
    revision?: string
  ) {
    const where = {
      environmentId_taskIdentifier_errorFingerprint: {
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
      },
    };

    const now = new Date();
    const ignoredUntil = params.duration ? new Date(now.getTime() + params.duration) : null;

    const data = {
      status: "IGNORED" as const,
      ignoredAt: now,
      ignoredUntil,
      ignoredUntilOccurrenceRate: params.occurrenceRateThreshold ?? null,
      ignoredUntilTotalOccurrences: params.totalOccurrencesThreshold ?? null,
      ignoredAtOccurrenceCount: params.occurrenceCountAtIgnoreTime ?? null,
      ignoredReason: params.reason ?? null,
      ignoredByUserId: params.userId ?? null,
      resolvedAt: null,
      resolvedInVersion: null,
      resolvedBy: null,
    };

    const create = {
      organizationId: identifier.organizationId,
      projectId: identifier.projectId,
      environmentId: identifier.environmentId,
      taskIdentifier: identifier.taskIdentifier,
      errorFingerprint: identifier.errorFingerprint,
      ...data,
    };
    if (revision !== undefined) {
      return writeAtRevision(this._prisma, identifier, data, create, revision);
    }

    return this._prisma.errorGroupState.upsert({ where, update: data, create });
  }

  async unresolveError(identifier: ErrorGroupIdentifier, revision?: string) {
    const where = {
      environmentId_taskIdentifier_errorFingerprint: {
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
      },
    };

    const update = {
      status: "UNRESOLVED" as const,
      resolvedAt: null,
      resolvedInVersion: null,
      resolvedBy: null,
      ignoredUntil: null,
      ignoredUntilOccurrenceRate: null,
      ignoredUntilTotalOccurrences: null,
      ignoredAtOccurrenceCount: null,
      ignoredAt: null,
      ignoredReason: null,
      ignoredByUserId: null,
    };
    const create = {
      organizationId: identifier.organizationId,
      projectId: identifier.projectId,
      environmentId: identifier.environmentId,
      taskIdentifier: identifier.taskIdentifier,
      errorFingerprint: identifier.errorFingerprint,
      status: "UNRESOLVED" as const,
    };
    if (revision !== undefined) {
      return writeAtRevision(this._prisma, identifier, update, create, revision);
    }

    return this._prisma.errorGroupState.upsert({ where, update, create });
  }
}
