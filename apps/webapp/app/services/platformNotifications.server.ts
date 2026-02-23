import { z } from "zod";
import { errAsync, fromPromise, type ResultAsync } from "neverthrow";
import { prisma } from "~/db.server";
import { type PlatformNotificationScope, type PlatformNotificationSurface } from "@trigger.dev/database";

// --- Payload schema (spec v1) ---

const CardDataV1Schema = z.object({
  type: z.literal("card"),
  title: z.string(),
  description: z.string(),
  image: z.string().url().optional(),
  actionLabel: z.string().optional(),
  actionUrl: z.string().url().optional(),
  dismissOnAction: z.boolean().optional(),
});

const PayloadV1Schema = z.object({
  version: z.literal("1"),
  data: CardDataV1Schema,
});

export type PayloadV1 = z.infer<typeof PayloadV1Schema>;

export type PlatformNotificationWithPayload = {
  id: string;
  friendlyId: string;
  scope: string;
  priority: number;
  payload: PayloadV1;
  isRead: boolean;
};

// --- Read: active notifications for webapp ---

export async function getActivePlatformNotifications({
  userId,
  organizationId,
  projectId,
}: {
  userId: string;
  organizationId: string;
  projectId?: string;
}) {
  const now = new Date();

  const notifications = await prisma.platformNotification.findMany({
    where: {
      surface: "WEBAPP",
      archivedAt: null,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
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
  const existing = await prisma.platformNotificationInteraction.findUnique({
    where: { notificationId_userId: { notificationId, userId } },
  });

  if (existing) {
    await prisma.platformNotificationInteraction.update({
      where: { id: existing.id },
      data: onUpdate,
    });
    return;
  }

  await prisma.platformNotificationInteraction.create({
    data: {
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

// --- CLI: next notification for CLI surface ---

function isCliNotificationExpired(
  interaction: { firstSeenAt: Date; showCount: number } | null,
  notification: { cliMaxDaysAfterFirstSeen: number | null; cliMaxShowCount: number | null }
): boolean {
  if (!interaction) return false;

  if (
    notification.cliMaxShowCount !== null &&
    interaction.showCount >= notification.cliMaxShowCount
  ) {
    return true;
  }

  if (notification.cliMaxDaysAfterFirstSeen !== null) {
    const daysSinceFirstSeen =
      (Date.now() - interaction.firstSeenAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceFirstSeen > notification.cliMaxDaysAfterFirstSeen) {
      return true;
    }
  }

  return false;
}

export async function getNextCliNotification({
  userId,
  projectRef,
}: {
  userId: string;
  projectRef?: string;
}): Promise<{
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
    const project = await prisma.project.findFirst({
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
    const membership = await prisma.orgMember.findFirst({
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

  const notifications = await prisma.platformNotification.findMany({
    where: {
      surface: "CLI",
      archivedAt: null,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
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

  for (const n of sorted) {
    const interaction = n.interactions[0] ?? null;

    if (interaction?.cliDismissedAt) continue;
    if (isCliNotificationExpired(interaction, n)) continue;

    const parsed = PayloadV1Schema.safeParse(n.payload);
    if (!parsed.success) continue;

    // Upsert interaction: increment showCount or create
    if (interaction) {
      await prisma.platformNotificationInteraction.update({
        where: { id: interaction.id },
        data: { showCount: { increment: 1 } },
      });

      return {
        id: n.id,
        payload: parsed.data,
        showCount: interaction.showCount + 1,
        firstSeenAt: interaction.firstSeenAt.toISOString(),
      };
    } else {
      const newInteraction = await prisma.platformNotificationInteraction.create({
        data: {
          notificationId: n.id,
          userId,
          firstSeenAt: now,
          showCount: 1,
        },
      });

      return {
        id: n.id,
        payload: parsed.data,
        showCount: 1,
        firstSeenAt: newInteraction.firstSeenAt.toISOString(),
      };
    }
  }

  return null;
}

// --- Create: admin endpoint support ---

const SCOPE_REQUIRED_FK: Record<string, "userId" | "organizationId" | "projectId"> = {
  USER: "userId",
  ORGANIZATION: "organizationId",
  PROJECT: "projectId",
};

const ALL_FK_FIELDS = ["userId", "organizationId", "projectId"] as const;
const CLI_ONLY_FIELDS = ["cliMaxDaysAfterFirstSeen", "cliMaxShowCount"] as const;

export const CreatePlatformNotificationSchema = z
  .object({
    title: z.string().min(1),
    payload: PayloadV1Schema,
    surface: z.enum(["WEBAPP", "CLI"]),
    scope: z.enum(["USER", "PROJECT", "ORGANIZATION", "GLOBAL"]),
    userId: z.string().optional(),
    organizationId: z.string().optional(),
    projectId: z.string().optional(),
    startsAt: z
      .string()
      .datetime()
      .transform((s) => new Date(s))
      .optional(),
    endsAt: z
      .string()
      .datetime()
      .transform((s) => new Date(s))
      .optional(),
    priority: z.number().int().default(0),
    cliMaxDaysAfterFirstSeen: z.number().int().positive().optional(),
    cliMaxShowCount: z.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    validateScopeForeignKeys(data, ctx);
    validateSurfaceFields(data, ctx);
    validateStartsAt(data, ctx);
  });

function validateScopeForeignKeys(
  data: { scope: string; userId?: string; organizationId?: string; projectId?: string },
  ctx: z.RefinementCtx
) {
  const requiredFk = SCOPE_REQUIRED_FK[data.scope];

  if (requiredFk && !data[requiredFk]) {
    ctx.addIssue({
      code: "custom",
      message: `${requiredFk} is required when scope is ${data.scope}`,
      path: [requiredFk],
    });
  }

  const forbiddenFks = ALL_FK_FIELDS.filter((fk) => fk !== requiredFk);
  for (const fk of forbiddenFks) {
    if (data[fk]) {
      ctx.addIssue({
        code: "custom",
        message: `${fk} must not be set when scope is ${data.scope}`,
        path: [fk],
      });
    }
  }
}

function validateSurfaceFields(
  data: { surface: string; cliMaxDaysAfterFirstSeen?: number; cliMaxShowCount?: number },
  ctx: z.RefinementCtx
) {
  if (data.surface !== "WEBAPP") return;

  for (const field of CLI_ONLY_FIELDS) {
    if (data[field] !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${field} is not allowed for WEBAPP surface`,
        path: [field],
      });
    }
  }
}

function validateStartsAt(data: { startsAt?: Date }, ctx: z.RefinementCtx) {
  if (!data.startsAt) return;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (data.startsAt < oneHourAgo) {
    ctx.addIssue({
      code: "custom",
      message: "startsAt must be within the last hour or in the future",
      path: ["startsAt"],
    });
  }
}

export type CreatePlatformNotificationInput = z.input<typeof CreatePlatformNotificationSchema>;

type CreateError =
  | { type: "validation"; issues: z.ZodIssue[] }
  | { type: "db"; message: string };

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
      },
      select: { id: true, friendlyId: true },
    }),
    (e): CreateError => ({
      type: "db",
      message: e instanceof Error ? e.message : String(e),
    })
  );
}
