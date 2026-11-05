import { json } from "@remix-run/server-runtime";
import type { NotifierRef } from "@internal/alert-contracts";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import { createAlertGroup } from "~/v3/services/alerts/alertGroups.server";
import { findValidNotifierChannelIds } from "~/v3/services/alerts/validateNotifierChannels.server";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { v3AlertPath } from "~/utils/pathBuilder";

const GroupRequestSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  memberAlertIds: z.array(z.string().min(1)).max(200),
  compositeMode: z.enum(["any", "all"]),
  name: z.string().trim().min(1).max(120),
  notifierChannelIds: z.array(z.string()).min(1, "At least one channel is required"),
  expiresAt: z.string().datetime().optional(),
});

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

    const result = await createAlertGroup(prisma, {
      organizationId: body.organizationId,
      projectId: body.projectId,
      environmentId: body.environmentId,
      memberAlertIds: body.memberAlertIds,
      compositeMode: body.compositeMode,
      name: body.name,
      notifiers,
      expiresAt,
      createdBy: user.id,
    });
    if (!result.ok) return json({ error: result.error }, { status: 400 });

    return json({
      ok: true,
      alertId: result.alert.id,
      path: v3AlertPath(
        { slug: project.organization.slug },
        { slug: project.slug },
        { slug: environment.slug },
        result.alert.id
      ),
    });
  }
);
