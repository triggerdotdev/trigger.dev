import { type SupportAccessMode, type SupportAccessRequest } from "@trigger.dev/database";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { $transaction, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { SUPPORT_ACCESS_APPROVAL_DAYS, pendingRequestCutoff } from "~/utils/supportAccess";

const APPROVAL_MS = SUPPORT_ACCESS_APPROVAL_DAYS * 24 * 60 * 60 * 1000;

type DbError = { type: "other"; cause: unknown };

export type SessionAccess =
  | { type: "allow"; organizationId: string }
  | { type: "scoped"; organizationId: string; expiresAt: Date; requestId: string }
  | { type: "request_required"; organizationId: string };

const toDbError = (cause: unknown): DbError => ({ type: "other", cause });

export class SupportAccessService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  resolveSessionAccess({
    organizationSlug,
    userId,
    now = new Date(),
  }: {
    organizationSlug: string;
    userId: string;
    now?: Date;
  }): ResultAsync<SessionAccess, DbError | { type: "org_not_found" } | { type: "not_a_member" }> {
    return fromPromise(
      this.#prismaClient.organization.findFirst({
        where: { slug: organizationSlug, deletedAt: null },
        select: {
          id: true,
          supportAccessMode: true,
          members: { where: { userId }, select: { id: true }, take: 1 },
        },
      }),
      toDbError
    ).andThen((org) => {
      if (!org) {
        return errAsync({ type: "org_not_found" as const });
      }
      if (org.members.length === 0) {
        return errAsync({ type: "not_a_member" as const });
      }
      if (org.supportAccessMode === "ALLOW") {
        return okAsync<SessionAccess>({ type: "allow", organizationId: org.id });
      }
      return this.getActiveApproval(org.id, now).map((approval): SessionAccess => {
        if (!approval?.expiresAt) {
          return { type: "request_required", organizationId: org.id };
        }
        return {
          type: "scoped",
          organizationId: org.id,
          expiresAt: approval.expiresAt,
          requestId: approval.id,
        };
      });
    });
  }

  getActiveApproval(
    organizationId: string,
    now: Date = new Date()
  ): ResultAsync<SupportAccessRequest | null, DbError> {
    return fromPromise(
      this.#prismaClient.supportAccessRequest.findFirst({
        where: { organizationId, status: "APPROVED", expiresAt: { gt: now } },
        orderBy: { expiresAt: "desc" },
      }),
      toDbError
    );
  }

  createRequest({
    organizationId,
    requestedById,
    reason,
  }: {
    organizationId: string;
    requestedById: string;
    reason: string;
  }): ResultAsync<
    SupportAccessRequest & { organization: { slug: string } },
    | DbError
    | { type: "reason_required" }
    | { type: "org_not_found" }
    | { type: "org_allows_access" }
  > {
    const trimmed = reason.trim();
    if (!trimmed) {
      return errAsync({ type: "reason_required" as const });
    }

    return fromPromise(
      this.#prismaClient.organization.findFirst({
        where: { id: organizationId, deletedAt: null },
        select: { supportAccessMode: true },
      }),
      toDbError
    ).andThen((org) => {
      if (!org) {
        return errAsync({ type: "org_not_found" as const });
      }
      if (org.supportAccessMode === "ALLOW") {
        return errAsync({ type: "org_allows_access" as const });
      }
      return fromPromise(
        this.#prismaClient.supportAccessRequest.create({
          data: { organizationId, requestedById, reason: trimmed },
          include: { organization: { select: { slug: true } } },
        }),
        toDbError
      );
    });
  }

  approveRequest({
    organizationId,
    requestId,
    approvedById,
    now = new Date(),
  }: {
    organizationId: string;
    requestId: string;
    approvedById: string;
    now?: Date;
  }): ResultAsync<{ expiresAt: Date }, DbError | { type: "request_not_pending" }> {
    const expiresAt = new Date(now.getTime() + APPROVAL_MS);

    return fromPromise(
      this.#prismaClient.supportAccessRequest.updateMany({
        where: {
          id: requestId,
          organizationId,
          status: "PENDING",
          createdAt: { gt: pendingRequestCutoff(now) },
          organization: { supportAccessMode: "REQUIRES_REQUEST" },
        },
        data: { status: "APPROVED", approvedById, approvedAt: now, expiresAt },
      }),
      toDbError
    ).andThen(({ count }) => {
      if (count === 0) {
        return errAsync({ type: "request_not_pending" as const });
      }
      return okAsync({ expiresAt });
    });
  }

  cancelRequest({
    organizationId,
    requestId,
    cancelledById,
    now = new Date(),
  }: {
    organizationId: string;
    requestId: string;
    cancelledById: string;
    now?: Date;
  }): ResultAsync<void, DbError | { type: "request_not_pending" }> {
    return fromPromise(
      this.#prismaClient.supportAccessRequest.updateMany({
        where: { id: requestId, organizationId, status: "PENDING" },
        data: { status: "CANCELLED", cancelledById, cancelledAt: now },
      }),
      toDbError
    ).andThen(({ count }) => {
      if (count === 0) {
        return errAsync({ type: "request_not_pending" as const });
      }
      return okAsync(undefined);
    });
  }

  setMode({
    organizationId,
    mode,
    updatedById,
    now = new Date(),
  }: {
    organizationId: string;
    mode: SupportAccessMode;
    updatedById: string;
    now?: Date;
  }): ResultAsync<{ cancelledPending: number }, DbError> {
    return fromPromise(
      $transaction(this.#prismaClient, "supportAccess.setMode", async (tx) => {
        await tx.organization.update({
          where: { id: organizationId },
          data: {
            supportAccessMode: mode,
            supportAccessModeUpdatedAt: now,
            supportAccessModeUpdatedById: updatedById,
          },
        });

        if (mode !== "ALLOW") {
          return { cancelledPending: 0 };
        }

        const { count } = await tx.supportAccessRequest.updateMany({
          where: { organizationId, status: "PENDING" },
          data: { status: "CANCELLED", cancelledById: updatedById, cancelledAt: now },
        });
        return { cancelledPending: count };
      }),
      toDbError
    ).andThen((result) => {
      if (!result) {
        return errAsync(toDbError(new Error("setMode transaction returned no result")));
      }
      return okAsync(result);
    });
  }

  listRequests(organizationId: string) {
    return fromPromise(
      this.#prismaClient.supportAccessRequest.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          reason: true,
          status: true,
          createdAt: true,
          approvedAt: true,
          expiresAt: true,
          requestedBy: { select: { email: true } },
          approvedBy: { select: { email: true } },
        },
      }),
      toDbError
    );
  }
}
