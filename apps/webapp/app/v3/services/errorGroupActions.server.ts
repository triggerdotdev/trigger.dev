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
      userId: string;
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
        resolvedBy: params.userId,
        ignoredUntil: null,
        ignoredUntilOccurrenceRate: null,
        ignoredUntilTotalOccurrences: null,
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
        resolvedBy: params.userId,
      },
    });
  }

  async ignoreError(
    identifier: ErrorGroupIdentifier,
    params: {
      userId: string;
      duration?: number;
      occurrenceRateThreshold?: number;
      totalOccurrencesThreshold?: number;
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
      ignoredReason: params.reason ?? null,
      ignoredByUserId: params.userId,
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
