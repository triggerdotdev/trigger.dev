import { json } from "@remix-run/server-runtime";
import { getCapability, type NotifierRef } from "@internal/alert-contracts";
import { boundedIn } from "@trigger.dev/database";
import { z } from "zod";
import { groupCreatedMessage, joinPlanItemKeys } from "~/components/alerts/alertCreatedCard";
import { $replica, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import { appendCreatedMessage, ownsChat } from "~/v3/services/alerts/createdCardChat.server";
import { hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import { createAlertGroup } from "~/v3/services/alerts/alertGroups.server";
import {
  buildCondition,
  buildScope,
  ChatRequestSchema,
  type AlertDraftScope,
} from "~/v3/services/alerts/alertDraft";
import {
  buildAlertFromDraft,
  InvalidQueryAlertError,
  QUERY_DOMAIN_ERRORS,
  type NewAlertInput,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import { validateAlertDraft } from "~/v3/services/alerts/validateAlertDraft.server";
import { findValidNotifierChannelIds } from "~/v3/services/alerts/validateNotifierChannels.server";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { v3AlertPath } from "~/utils/pathBuilder";

const GroupRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    memberAlertIds: z.array(z.string().min(1)).max(200).optional(),
    members: z.array(ChatRequestSchema).min(2).max(20).optional(),
    compositeMode: z.enum(["any", "all"]),
    name: z.string().trim().min(1).max(120),
    notifierChannelIds: z.array(z.string()).min(1, "At least one channel is required"),
    expiresAt: z.string().datetime().optional(),
    transcriptChatId: z.string().min(1).optional(),
  })
  .refine((v) => !v.memberAlertIds !== !v.members, { path: ["members"] })
  .refine(
    (v) =>
      (v.members ?? []).every(
        (m) =>
          m.organizationId === v.organizationId &&
          m.projectId === v.projectId &&
          m.environmentId === v.environmentId
      ),
    { path: ["members"] }
  );

type GroupMember = z.infer<typeof ChatRequestSchema>;
type MemberContext = {
  userId: string;
  environmentType: Parameters<typeof findValidNotifierChannelIds>[3];
};

async function memberAlertInput(
  member: GroupMember,
  { userId, environmentType }: MemberContext
): Promise<{ input: NewAlertInput; validChannelIds: string[] } | Response> {
  const validChannelIds = await findValidNotifierChannelIds(
    $replica,
    member.projectId,
    member.form.notifierChannelIds,
    environmentType
  );
  if (validChannelIds.length !== member.form.notifierChannelIds.length) {
    return json({ error: "One or more selected notifiers were not found" }, { status: 400 });
  }
  const notifiers: NotifierRef[] = validChannelIds.map((channelId) => ({
    type: "channel",
    channelId,
  }));
  if (member.transcriptChatId) {
    const owned = await ownsChat({
      chatId: member.transcriptChatId,
      organizationId: member.organizationId,
      userId,
    });
    if (!owned) return json({ error: "Invalid chat reference" }, { status: 400 });
  }

  const scope = buildScope(member.form);
  const draftError = validateAlertDraft({
    capability: getCapability(member.form.capabilityKey),
    capabilityKey: member.form.capabilityKey,
    surface: "alerts_page",
    conditionKind: member.form.conditionKind,
    quietWindowSec:
      member.form.conditionKind === "absence"
        ? (member.form.quietWindowMinutes ?? 0) * 60
        : undefined,
    scope,
    compositeMode: member.form.compositeMode,
    signals: member.form.signals,
    components: member.form.components,
  });
  if (draftError) return json({ error: draftError.message }, { status: 400 });

  try {
    const input = buildAlertFromDraft({
      organizationId: member.organizationId,
      projectId: member.projectId,
      environmentId: member.environmentId,
      name: member.name,
      capabilityKey: member.form.capabilityKey,
      scope: scope as AlertDraftScope,
      condition: buildCondition(member.form),
      expiresAt: member.form.expiresAt ? new Date(member.form.expiresAt) : undefined,
      notifiers,
      createdBy: userId,
      query: member.form.query,
      querySignalChoice: member.form.querySignalChoice,
    });
    return { input, validChannelIds };
  } catch (error) {
    if (error instanceof InvalidQueryAlertError) {
      return json({ error: error.message }, { status: 422 });
    }
    if (QUERY_DOMAIN_ERRORS.some((cls) => error instanceof cls)) {
      return json({ error: (error as Error).message }, { status: 400 });
    }
    throw error;
  }
}

async function appendGroupCard({
  chat,
  alertId,
  body,
  memberAlertIds,
  channelIds,
  expiresAt,
}: {
  chat: { chatId: string; userId: string; organizationId: string };
  alertId: string;
  body: z.infer<typeof GroupRequestSchema>;
  memberAlertIds: string[];
  channelIds: string[];
  expiresAt?: Date;
}) {
  try {
    const [members, channels] = await Promise.all([
      prisma.alert.findMany({
        where: { id: { in: boundedIn(memberAlertIds) }, projectId: body.projectId },
        select: { id: true, name: true, capabilityKey: true, params: true },
      }),
      $replica.projectAlertChannel.findMany({
        where: { id: { in: boundedIn(channelIds) }, projectId: body.projectId },
        select: { id: true, name: true },
      }),
    ]);
    const message = groupCreatedMessage(
      alertId,
      {
        name: body.name,
        compositeMode: body.compositeMode,
        memberNames: memberAlertIds
          .map((id) => members.find((m) => m.id === id))
          .filter((m) => m !== undefined)
          .map(alertDisplayName),
        channelNames: channels.map((c) => c.name),
        expiresAt: expiresAt?.toISOString(),
      },
      joinPlanItemKeys((body.members ?? []).map((m) => m.planItemKey))
    );
    await appendCreatedMessage(chat, alertId, message);
    return message;
  } catch (error) {
    logger.error("Failed to build the group created card", { alertId, error });
    return undefined;
  }
}

async function bodyScope(_params: unknown, request: Request) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const parsed = z
    .object({ organizationId: z.string().optional(), projectId: z.string().optional() })
    .safeParse(body);
  return parsed.success ? parsed.data : {};
}

export const action = dashboardAction(
  { context: bodyScope, authorization: { action: "write", resource: { type: "alerts" } } },
  async ({ request, user, ability }) => {
    const parsed = GroupRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }
    const body = parsed.data;

    const access = await hasAccessToEnvironment({
      environmentId: body.environmentId,
      projectId: body.projectId,
      organizationId: body.organizationId,
      userId: user.id,
    });
    if (!access) return json({ error: "No access to this environment" }, { status: 403 });

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: { id: body.environmentId },
      select: {
        type: true,
        slug: true,
        branchName: true,
        project: {
          select: { slug: true, organization: { select: { slug: true, featureFlags: true } } },
        },
      },
    });
    if (!environment) return json({ error: "No access to this environment" }, { status: 403 });
    const { project } = environment;
    const alertsEnabled = await canUseAlertsList({
      orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
      userId: user.id,
    });
    if (!alertsEnabled) return json({ error: "Alerts not enabled" }, { status: 403 });
    if (!ability.can("write", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    if (
      body.transcriptChatId &&
      !(await ownsChat({
        chatId: body.transcriptChatId,
        userId: user.id,
        organizationId: body.organizationId,
      }))
    ) {
      return json({ error: "Invalid chat reference" }, { status: 400 });
    }

    const validChannelIds = await findValidNotifierChannelIds(
      $replica,
      body.projectId,
      body.notifierChannelIds,
      environment.type
    );
    if (validChannelIds.length !== body.notifierChannelIds.length) {
      return json({ error: "One or more selected notifiers were not found" }, { status: 400 });
    }
    const notifiers: NotifierRef[] = validChannelIds.map((channelId) => ({
      type: "channel",
      channelId,
    }));
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return json({ error: "Pick an expiry in the future" }, { status: 400 });
    }

    const members: { input: NewAlertInput; validChannelIds: string[] }[] = [];
    for (const member of body.members ?? []) {
      const prepared = await memberAlertInput(member, {
        userId: user.id,
        environmentType: environment.type,
      });
      if (prepared instanceof Response) return prepared;
      members.push(prepared);
    }

    const result = await createAlertGroup(prisma, {
      organizationId: body.organizationId,
      projectId: body.projectId,
      environmentId: body.environmentId,
      memberAlertIds: body.memberAlertIds ?? [],
      members: members.map((m) => m.input),
      compositeMode: body.compositeMode,
      name: body.name,
      notifiers,
      expiresAt,
      createdBy: user.id,
    });
    if (!result.ok) return json({ error: result.error }, { status: 400 });

    const memberAlertIds = result.alert.condition.memberAlertIds as string[];
    const transcriptChatId = body.transcriptChatId ?? body.members?.[0]?.transcriptChatId;
    const message = transcriptChatId
      ? await appendGroupCard({
          chat: { chatId: transcriptChatId, userId: user.id, organizationId: body.organizationId },
          alertId: result.alert.id,
          body,
          memberAlertIds,
          channelIds: validChannelIds,
          expiresAt,
        })
      : undefined;

    return json({
      ok: true,
      alertId: result.alert.id,
      path: v3AlertPath(
        { slug: project.organization.slug },
        { slug: project.slug },
        { slug: environment.slug },
        result.alert.id
      ),
      memberAlertIds,
      message,
    });
  }
);
