import { type PrismaClientOrTransaction, prisma } from "~/db.server";

type ErrorGroupIdentifier = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  taskIdentifier: string;
  errorFingerprint: string;
};

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
    }
  ) {
    const where = {
      environmentId_taskIdentifier_errorFingerprint: {
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
      },
    };

    const now = new Date();

    return this._prisma.errorGroupState.upsert({
      where,
      update: {
        status: "RESOLVED",
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
      },
      create: {
        organizationId: identifier.organizationId,
        projectId: identifier.projectId,
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
        status: "RESOLVED",
        resolvedAt: now,
        resolvedInVersion: params.resolvedInVersion ?? null,
        resolvedBy: params.userId ?? null,
      },
    });
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
    }
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

    return this._prisma.errorGroupState.upsert({
      where,
      update: data,
      create: {
        organizationId: identifier.organizationId,
        projectId: identifier.projectId,
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
        ...data,
      },
    });
  }

  async unresolveError(identifier: ErrorGroupIdentifier) {
    const where = {
      environmentId_taskIdentifier_errorFingerprint: {
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
      },
    };

    return this._prisma.errorGroupState.upsert({
      where,
      update: {
        status: "UNRESOLVED",
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
      },
      create: {
        organizationId: identifier.organizationId,
        projectId: identifier.projectId,
        environmentId: identifier.environmentId,
        taskIdentifier: identifier.taskIdentifier,
        errorFingerprint: identifier.errorFingerprint,
        status: "UNRESOLVED",
      },
    });
  }
}
