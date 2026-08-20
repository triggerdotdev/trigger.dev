import type { z } from "zod";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { prisma } from "~/db.server";
import {
  type PlatformNotificationScope,
  type PlatformNotificationSurface,
  type PrismaClientOrTransaction,
} from "@trigger.dev/database";
import { incrementCliRequestCounter } from "./platformNotificationCounter.server";
import {
  CreateDraftPlatformNotificationSchema,
  type CreateDraftPlatformNotificationInput,
  CreatePlatformNotificationSchema,
  type CreatePlatformNotificationInput,
  type PayloadV1,
  PayloadV1Schema,
  PublishDraftPlatformNotificationSchema,
  type PublishDraftPlatformNotificationInput,
  UpdateDraftPlatformNotificationSchema,
  type UpdateDraftPlatformNotificationInput,
  UpdatePlatformNotificationSchema,
} from "./platformNotificationSchemas";
import { isCliVersionEligible } from "./platformNotificationVersionTargeting";

export {
  CreateDraftPlatformNotificationSchema,
  CreatePlatformNotificationSchema,
  PublishDraftPlatformNotificationSchema,
  UpdateDraftPlatformNotificationSchema,
  UpdatePlatformNotificationSchema,
} from "./platformNotificationSchemas";
export type {
  CreateDraftPlatformNotificationInput,
  CreatePlatformNotificationInput,
  PayloadV1,
  PublishDraftPlatformNotificationInput,
  UpdateDraftPlatformNotificationInput,
} from "./platformNotificationSchemas";

export type PlatformNotificationWithPayload = {
  id: string;
  friendlyId: string;
  scope: string;
  priority: number;
  payload: PayloadV1;
  isRead: boolean;
};

// --- Read: admin list with interaction stats ---

export async function getAdminNotificationsList(
  {
    page = 1,
    pageSize = 20,
    hideInactive = false,
  }: {
    page?: number;
    pageSize?: number;
    hideInactive?: boolean;
  },
  db: PrismaClientOrTransaction = prisma
) {
  // Drafts carry placeholder dates, so exempt them from the "inactive" (expired)
  // filter: a draft is neither active nor expired and must stay visible to admins.
  const where = hideInactive
    ? { archivedAt: null, OR: [{ isDraft: true }, { endsAt: { gt: new Date() } }] }
    : {};

  const [notifications, total] = await Promise.all([
    db.platformNotification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: {
          select: { interactions: true },
        },
        interactions: {
          select: {
            webappDismissedAt: true,
            webappClickedAt: true,
            cliDismissedAt: true,
          },
        },
      },
    }),
    db.platformNotification.count({ where }),
  ]);

  return {
    notifications: notifications.map((n) => {
      const parsed = PayloadV1Schema.safeParse(n.payload);
      return {
        id: n.id,
        friendlyId: n.friendlyId,
        title: n.title,
        surface: n.surface,
        scope: n.scope,
        userId: n.userId,
        organizationId: n.organizationId,
        projectId: n.projectId,
        priority: n.priority,
        startsAt: n.startsAt,
        endsAt: n.endsAt,
        isDraft: n.isDraft,
        archivedAt: n.archivedAt,
        createdAt: n.createdAt,
        payload: n.payload,
        payloadTitle: parsed.success ? parsed.data.data.title : null,
        payloadType: parsed.success ? parsed.data.data.type : null,
        payloadDescription: parsed.success ? parsed.data.data.description : null,
        payloadActionUrl: parsed.success ? parsed.data.data.actionUrl : null,
        payloadImage: parsed.success ? parsed.data.data.image : null,
        payloadDismissOnAction: parsed.success
          ? (parsed.data.data.dismissOnAction ?? false)
          : false,
        payloadDiscovery: parsed.success ? (parsed.data.data.discovery ?? null) : null,
        payloadMinimumCliVersion: parsed.success
          ? (parsed.data.data.minimumCliVersion ?? null)
          : null,
        cliMaxShowCount: n.cliMaxShowCount,
        cliMaxDaysAfterFirstSeen: n.cliMaxDaysAfterFirstSeen,
        cliShowEvery: n.cliShowEvery,
        stats: {
          seen: n._count.interactions,
          clicked: n.interactions.filter((i) => i.webappClickedAt !== null).length,
          dismissed: n.interactions.filter(
            (i) => i.webappDismissedAt !== null || i.cliDismissedAt !== null
          ).length,
        },
      };
    }),
    total,
    page,
    pageCount: Math.ceil(total / pageSize),
  };
}

// --- Read: active notifications for webapp ---

export async function getActivePlatformNotifications(
  {
    userId,
    organizationId,
    projectId,
  }: {
    userId: string;
    organizationId: string;
    projectId?: string;
  },
  db: PrismaClientOrTransaction = prisma
) {
  const now = new Date();

  const notifications = await db.platformNotification.findMany({
    where: {
      surface: "WEBAPP",
      archivedAt: null,
      isDraft: false,
      startsAt: { lte: now },
      endsAt: { gt: now },
      AND: [
        {
          OR: [
            { scope: "GLOBAL" },
            { scope: "ORGANIZATION", organizationId },
            ...(projectId ? [{ scope: "PROJECT" as const, projectId }] : []),
            { scope: "USER", userId },
          ],
        },
      ],
    },
    include: {
      interactions: {
        where: { userId },
      },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });

  type InternalNotification = PlatformNotificationWithPayload & { createdAt: Date };
  const result: InternalNotification[] = [];

  for (const n of notifications) {
    const interaction = n.interactions[0] ?? null;

    if (interaction?.webappDismissedAt) continue;

    const parsed = PayloadV1Schema.safeParse(n.payload);
    if (!parsed.success) continue;

    result.push({
      id: n.id,
      friendlyId: n.friendlyId,
      scope: n.scope,
      priority: n.priority,
      createdAt: n.createdAt,
      payload: parsed.data,
      isRead: !!interaction,
    });
  }

  result.sort(compareNotifications);

  const unreadCount = result.filter((n) => !n.isRead).length;
  const notifications_out: PlatformNotificationWithPayload[] = result.map(
    ({ createdAt: _, ...rest }) => rest
  );

  return { notifications: notifications_out, unreadCount };
}

function compareNotifications(
  a: { priority: number; createdAt: Date },
  b: { priority: number; createdAt: Date }
) {
  const priorityDiff = b.priority - a.priority;
  if (priorityDiff !== 0) return priorityDiff;

  return b.createdAt.getTime() - a.createdAt.getTime();
}

// --- Write: upsert interaction ---

async function upsertInteraction({
  notificationId,
  userId,
  onUpdate,
  onCreate,
}: {
  notificationId: string;
  userId: string;
  onUpdate: Record<string, unknown>;
  onCreate: Record<string, unknown>;
}) {
  await prisma.platformNotificationInteraction.upsert({
    where: { notificationId_userId: { notificationId, userId } },
    update: onUpdate,
    create: {
      notificationId,
      userId,
      firstSeenAt: new Date(),
      showCount: 1,
      ...onCreate,
    },
  });
}

export async function recordNotificationSeen({
  notificationId,
  userId,
}: {
  notificationId: string;
  userId: string;
}) {
  return upsertInteraction({
    notificationId,
    userId,
    onUpdate: { showCount: { increment: 1 } },
    onCreate: {},
  });
}

export async function dismissNotification({
  notificationId,
  userId,
}: {
  notificationId: string;
  userId: string;
}) {
  const now = new Date();
  return upsertInteraction({
    notificationId,
    userId,
    onUpdate: { webappDismissedAt: now },
    onCreate: { webappDismissedAt: now },
  });
}

export async function recordNotificationClicked({
  notificationId,
  userId,
}: {
  notificationId: string;
  userId: string;
}) {
  const now = new Date();
  return upsertInteraction({
    notificationId,
    userId,
    onUpdate: { webappClickedAt: now },
    onCreate: { webappClickedAt: now },
  });
}

// --- Membership verification ---

export async function verifyOrgMembership({
  userId,
  organizationId,
  projectId,
}: {
  userId: string;
  organizationId?: string;
  projectId?: string;
}): Promise<{ organizationId?: string; projectId?: string }> {
  if (!organizationId) return {};

  const membership = await prisma.orgMember.findFirst({
    where: { userId, organizationId },
    select: { organizationId: true },
  });

  if (!membership) return {};

  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!project) return { organizationId };
  }

  return { organizationId, projectId };
}

// --- Read: recent changelogs (for Help & Feedback) ---

export async function getRecentChangelogs(
  {
    userId,
    organizationId,
    projectId,
    limit = 2,
  }: {
    userId: string;
    organizationId?: string;
    projectId?: string;
    limit?: number;
  },
  db: PrismaClientOrTransaction = prisma
) {
  // NOTE: Intentionally not filtering by archivedAt or endsAt.
  // We want to show archived and expired changelogs in the "What's new" section
  // so users can still find recent release notes.
  // We DO filter by scope (to prevent user-scoped changelogs leaking to others),
  // by startsAt (to hide changelogs scheduled for the future), and by isDraft
  // (drafts have no real schedule and must never surface to users).
  const notifications = await db.platformNotification.findMany({
    where: {
      surface: "WEBAPP",
      isDraft: false,
      payload: { path: ["data", "type"], equals: "changelog" },
      startsAt: { lte: new Date() },
      OR: [
        { scope: "GLOBAL" },
        { scope: "USER", userId },
        ...(organizationId ? [{ scope: "ORGANIZATION" as const, organizationId }] : []),
        ...(projectId ? [{ scope: "PROJECT" as const, projectId }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });

  return notifications
    .map((n) => {
      const parsed = PayloadV1Schema.safeParse(n.payload);
      if (!parsed.success) return null;
      return { id: n.id, title: parsed.data.data.title, actionUrl: parsed.data.data.actionUrl };
    })
    .filter(Boolean) as Array<{ id: string; title: string; actionUrl?: string }>;
}

// --- CLI: next notification for CLI surface ---

function isCliNotificationExpired(
  interaction: {
    userId: string;
    firstSeenAt: Date;
    showCount: number;
    cliDismissedAt: Date | null;
  } | null,
  notification: {
    id: string;
    cliMaxDaysAfterFirstSeen: number | null;
    cliMaxShowCount: number | null;
  },
  db: PrismaClientOrTransaction = prisma
): boolean {
  if (!interaction) return false;

  let expired = false;

  if (
    notification.cliMaxShowCount !== null &&
    interaction.showCount >= notification.cliMaxShowCount
  ) {
    expired = true;
  }

  if (!expired && notification.cliMaxDaysAfterFirstSeen !== null) {
    const daysSinceFirstSeen =
      (Date.now() - interaction.firstSeenAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceFirstSeen > notification.cliMaxDaysAfterFirstSeen) {
      expired = true;
    }
  }

  // For time-based expiration, persist the dismiss on the next request
  // (showCount-based dismissal is handled inline at display time)
  if (expired && !interaction.cliDismissedAt) {
    void db.platformNotificationInteraction.update({
      where: {
        notificationId_userId: {
          notificationId: notification.id,
          userId: interaction.userId,
        },
      },
      data: { cliDismissedAt: new Date() },
    });
  }

  return expired;
}

export async function getNextCliNotification(
  {
    userId,
    projectRef,
    cliVersion,
  }: {
    userId: string;
    projectRef?: string;
    cliVersion?: string;
  },
  db: PrismaClientOrTransaction = prisma
): Promise<{
  id: string;
  payload: PayloadV1;
  showCount: number;
  firstSeenAt: string;
} | null> {
  const now = new Date();

  // Resolve organizationId and projectId from projectRef if provided
  let organizationId: string | undefined;
  let projectId: string | undefined;

  if (projectRef) {
    const project = await db.project.findFirst({
      where: {
        externalRef: projectRef,
        deletedAt: null,
        organization: {
          deletedAt: null,
          members: { some: { userId } },
        },
      },
      select: { id: true, organizationId: true },
    });

    if (project) {
      projectId = project.id;
      organizationId = project.organizationId;
    }
  }

  // If no projectRef or project not found, get org from membership
  if (!organizationId) {
    const membership = await db.orgMember.findFirst({
      where: { userId },
      select: { organizationId: true },
    });
    if (membership) {
      organizationId = membership.organizationId;
    }
  }

  const scopeFilter: Array<Record<string, unknown>> = [
    { scope: "GLOBAL" },
    { scope: "USER", userId },
  ];

  if (organizationId) {
    scopeFilter.push({ scope: "ORGANIZATION", organizationId });
  }

  if (projectId) {
    scopeFilter.push({ scope: "PROJECT", projectId });
  }

  const notifications = await db.platformNotification.findMany({
    where: {
      surface: "CLI",
      archivedAt: null,
      isDraft: false,
      startsAt: { lte: now },
      endsAt: { gt: now },
      AND: [{ OR: scopeFilter }],
    },
    include: {
      interactions: {
        where: { userId },
      },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });

  const sorted = [...notifications].sort(compareNotifications);

  // Global per-user request counter stored in Redis, used for cliShowEvery modulo.
  // This is independent of per-notification showCount so that cliMaxShowCount
  // correctly tracks actual displays, not API encounters.
  const requestCounter = await incrementCliRequestCounter(userId);

  for (const n of sorted) {
    const interaction = n.interactions[0] ?? null;

    if (interaction?.cliDismissedAt) continue;

    const parsed = PayloadV1Schema.safeParse(n.payload);
    if (!parsed.success) continue;
    if (!isCliVersionEligible(parsed.data.data.minimumCliVersion, cliVersion)) continue;
    if (isCliNotificationExpired(interaction, n, db)) continue;

    // Check cliShowEvery using the global request counter
    if (n.cliShowEvery !== null && requestCounter % n.cliShowEvery !== 0) {
      continue;
    }

    // Only increment showCount when the notification will actually be displayed.
    // If this display reaches cliMaxShowCount, also set cliDismissedAt now
    // so it's recorded immediately rather than waiting for a future request.
    const reachedMaxShows =
      n.cliMaxShowCount !== null && (interaction?.showCount ?? 0) + 1 >= n.cliMaxShowCount;

    const updated = await db.platformNotificationInteraction.upsert({
      where: { notificationId_userId: { notificationId: n.id, userId } },
      update: {
        showCount: { increment: 1 },
        ...(reachedMaxShows ? { cliDismissedAt: now } : {}),
      },
      create: {
        notificationId: n.id,
        userId,
        firstSeenAt: now,
        showCount: 1,
        ...(reachedMaxShows ? { cliDismissedAt: now } : {}),
      },
    });

    return {
      id: n.id,
      payload: parsed.data,
      showCount: updated.showCount,
      firstSeenAt: updated.firstSeenAt.toISOString(),
    };
  }

  return null;
}

// --- Create and update: admin endpoint support ---

type CreateError =
  | { type: "validation"; issues: z.ZodIssue[] }
  | { type: "db"; message: string }
  | { type: "conflict"; message: string };

export function createPlatformNotification(
  input: CreatePlatformNotificationInput
): ResultAsync<{ id: string; friendlyId: string }, CreateError> {
  const parseResult = CreatePlatformNotificationSchema.safeParse(input);

  if (!parseResult.success) {
    return errAsync({ type: "validation", issues: parseResult.error.issues });
  }

  const data = parseResult.data;

  return fromPromise(
    prisma.platformNotification.create({
      data: {
        title: data.title,
        payload: data.payload,
        surface: data.surface as PlatformNotificationSurface,
        scope: data.scope as PlatformNotificationScope,
        userId: data.userId,
        organizationId: data.organizationId,
        projectId: data.projectId,
        startsAt: data.startsAt ?? new Date(),
        endsAt: data.endsAt,
        priority: data.priority,
        cliMaxDaysAfterFirstSeen: data.cliMaxDaysAfterFirstSeen,
        cliMaxShowCount: data.cliMaxShowCount,
        cliShowEvery: data.cliShowEvery,
      },
      select: { id: true, friendlyId: true },
    }),
    (e): CreateError => ({
      type: "db",
      message: e instanceof Error ? e.message : String(e),
    })
  );
}

export function updatePlatformNotification(
  input: z.input<typeof UpdatePlatformNotificationSchema>
): ResultAsync<{ id: string; friendlyId: string }, CreateError> {
  const parseResult = UpdatePlatformNotificationSchema.safeParse(input);

  if (!parseResult.success) {
    return errAsync({ type: "validation", issues: parseResult.error.issues });
  }

  const data = parseResult.data;

  return fromPromise(
    prisma.platformNotification.update({
      where: { id: data.id },
      data: {
        title: data.title,
        payload: data.payload,
        surface: data.surface as PlatformNotificationSurface,
        scope: data.scope as PlatformNotificationScope,
        userId: data.scope === "USER" ? data.userId : null,
        organizationId: data.scope === "ORGANIZATION" ? data.organizationId : null,
        projectId: data.scope === "PROJECT" ? data.projectId : null,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        priority: data.priority,
        cliMaxDaysAfterFirstSeen:
          data.surface === "CLI" ? (data.cliMaxDaysAfterFirstSeen ?? null) : null,
        cliMaxShowCount: data.surface === "CLI" ? (data.cliMaxShowCount ?? null) : null,
        cliShowEvery: data.surface === "CLI" ? (data.cliShowEvery ?? null) : null,
      },
      select: { id: true, friendlyId: true },
    }),
    (e): CreateError => ({
      type: "db",
      message: e instanceof Error ? e.message : String(e),
    })
  );
}

export function createDraftPlatformNotification(
  input: CreateDraftPlatformNotificationInput,
  db: PrismaClientOrTransaction = prisma
): ResultAsync<{ id: string; friendlyId: string }, CreateError> {
  const parseResult = CreateDraftPlatformNotificationSchema.safeParse(input);

  if (!parseResult.success) {
    return errAsync({ type: "validation", issues: parseResult.error.issues });
  }

  const data = parseResult.data;

  // Drafts carry no real schedule. Store placeholder dates (ignored while
  // isDraft is true) — publishing sets the real startsAt/endsAt.
  const now = new Date();

  return fromPromise(
    db.platformNotification.create({
      data: {
        title: data.title,
        payload: data.payload,
        surface: data.surface as PlatformNotificationSurface,
        scope: data.scope as PlatformNotificationScope,
        userId: data.userId,
        organizationId: data.organizationId,
        projectId: data.projectId,
        startsAt: now,
        endsAt: now,
        priority: data.priority,
        cliMaxDaysAfterFirstSeen: data.cliMaxDaysAfterFirstSeen,
        cliMaxShowCount: data.cliMaxShowCount,
        cliShowEvery: data.cliShowEvery,
        isDraft: true,
      },
      select: { id: true, friendlyId: true },
    }),
    (e): CreateError => ({
      type: "db",
      message: e instanceof Error ? e.message : String(e),
    })
  );
}

export function updateDraftPlatformNotification(
  input: UpdateDraftPlatformNotificationInput,
  db: PrismaClientOrTransaction = prisma
): ResultAsync<{ id: string }, CreateError> {
  const parseResult = UpdateDraftPlatformNotificationSchema.safeParse(input);

  if (!parseResult.success) {
    return errAsync({ type: "validation", issues: parseResult.error.issues });
  }

  const data = parseResult.data;

  // Editing a draft touches content only; startsAt/endsAt/isDraft are left as-is
  // so the notification stays an unscheduled draft until it is published.
  // `isDraft: true` in the predicate makes this a no-op against a non-draft row,
  // so draft-only semantics can never be applied to an active/pending/archived one.
  return fromPromise(
    db.platformNotification.updateMany({
      where: { id: data.id, isDraft: true },
      data: {
        title: data.title,
        payload: data.payload,
        surface: data.surface as PlatformNotificationSurface,
        scope: data.scope as PlatformNotificationScope,
        userId: data.scope === "USER" ? data.userId : null,
        organizationId: data.scope === "ORGANIZATION" ? data.organizationId : null,
        projectId: data.scope === "PROJECT" ? data.projectId : null,
        priority: data.priority,
        cliMaxDaysAfterFirstSeen:
          data.surface === "CLI" ? (data.cliMaxDaysAfterFirstSeen ?? null) : null,
        cliMaxShowCount: data.surface === "CLI" ? (data.cliMaxShowCount ?? null) : null,
        cliShowEvery: data.surface === "CLI" ? (data.cliShowEvery ?? null) : null,
      },
    }),
    (e): CreateError => ({
      type: "db",
      message: e instanceof Error ? e.message : String(e),
    })
  ).andThen(({ count }) =>
    count === 0
      ? errAsync<{ id: string }, CreateError>({
          type: "conflict",
          message: "Notification not found or is not a draft",
        })
      : okAsync({ id: data.id })
  );
}

export function publishDraftPlatformNotification(
  input: PublishDraftPlatformNotificationInput,
  db: PrismaClientOrTransaction = prisma
): ResultAsync<{ id: string }, CreateError> {
  const parseResult = PublishDraftPlatformNotificationSchema.safeParse(input);

  if (!parseResult.success) {
    return errAsync({ type: "validation", issues: parseResult.error.issues });
  }

  const data = parseResult.data;

  // `isDraft: true` in the predicate ensures we only publish an actual draft:
  // a request naming a non-draft id updates zero rows and reports a conflict
  // rather than resetting a live notification's schedule.
  return fromPromise(
    db.platformNotification.updateMany({
      where: { id: data.id, isDraft: true },
      data: { startsAt: data.startsAt, endsAt: data.endsAt, isDraft: false },
    }),
    (e): CreateError => ({
      type: "db",
      message: e instanceof Error ? e.message : String(e),
    })
  ).andThen(({ count }) =>
    count === 0
      ? errAsync<{ id: string }, CreateError>({
          type: "conflict",
          message: "Notification not found or is not a draft",
        })
      : okAsync({ id: data.id })
  );
}

export async function deletePlatformNotification(id: string): Promise<void> {
  await prisma.platformNotification.delete({ where: { id } });
}

export async function publishNowPlatformNotification(id: string): Promise<void> {
  await prisma.platformNotification.update({
    where: { id },
    data: { startsAt: new Date() },
  });
}

export async function archivePlatformNotification(id: string): Promise<void> {
  await prisma.platformNotification.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
}
