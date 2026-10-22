import { parseWithZod } from "@conform-to/zod/v4";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  AlertChannelFormSchema,
  formDataToAlertChannel,
} from "~/components/alerts/AlertChannelForm";
import { RuntimeEnvironmentType } from "~/database-types";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { NewAlertChannelPresenter } from "~/presenters/v3/NewAlertChannelPresenter.server";
import { logger } from "~/services/logger.server";
import { getLimit } from "~/services/platform.v3.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import {
  type CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";
import { availableAlertChannelWhere } from "~/v3/services/alerts/validateNotifierChannels.server";
import {
  assertSafeWebhookUrl,
  UnsafeWebhookUrlError,
} from "~/v3/services/alerts/safeWebhookUrl.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  canAcrossEnvironments,
  requireAcrossEnvironments,
} from "~/v3/services/dashboardResourceAccess.server";

const QuerySchema = z.object({
  projectId: z.string().min(1),
  form: z.literal("1").optional(),
  environmentId: z.string().min(1).optional(),
});

const allEnvironmentTypes: CreateAlertChannelOptions["environmentTypes"] =
  Object.values(RuntimeEnvironmentType);

async function projectScope(_params: unknown, request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return {};
  const where = { id: projectId };
  const select = { id: true, organizationId: true };
  const project =
    (await $replica.project.findFirst({ where, select })) ??
    (await prisma.project.findFirst({ where, select }));
  return project ? { organizationId: project.organizationId, projectId: project.id } : {};
}

async function findMemberProject(request: Request, userId: string) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    projectId: url.searchParams.get("projectId"),
    form: url.searchParams.get("form") ?? undefined,
    environmentId: url.searchParams.get("environmentId") ?? undefined,
  });
  if (!parsed.success) return undefined;

  const where = {
    id: parsed.data.projectId,
    organization: { members: { some: { userId } } },
  };
  const select = {
    id: true,
    externalRef: true,
    organizationId: true,
    organization: { select: { featureFlags: true } },
  };
  const project =
    (await $replica.project.findFirst({ where, select })) ??
    (await prisma.project.findFirst({ where, select }));
  if (!project) {
    throw new Response(undefined, { status: 404 });
  }

  const alertsEnabled = await canUseAlertsList({
    orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
    userId,
  });
  if (!alertsEnabled) {
    throw new Response(undefined, { status: 404 });
  }

  return { project, withForm: parsed.data.form === "1", environmentId: parsed.data.environmentId };
}

// Checked in the handler, not the builder: the panel loads this with a fetcher,
// so a role without read:alerts must get an empty list rather than a 403.
export const loader = dashboardLoader(
  { context: projectScope },
  async ({ request, user, ability }) => {
    const found = await findMemberProject(request, user.id);
    if (!found || !ability.can("read", { type: "alerts" })) {
      return json({ channels: [], canWrite: false });
    }
    const { project, withForm, environmentId } = found;

    try {
      const environment = environmentId
        ? await $replica.runtimeEnvironment.findFirst({
            where: { id: environmentId, projectId: project.id },
            select: { type: true },
          })
        : undefined;
      if (environmentId && !environment) {
        return json({ channels: [], canWrite: false });
      }
      if (environment && !ability.can("read", { type: "alerts", envType: environment.type })) {
        return json({ channels: [], canWrite: false }, { status: 403 });
      }

      const [channels, used, limit] = await Promise.all([
        $replica.projectAlertChannel.findMany({
          where: availableAlertChannelWhere({
            projectId: project.id,
            environmentType: environment?.type,
          }),
          select: { id: true, name: true, type: true },
          orderBy: { name: "asc" },
        }),
        $replica.projectAlertChannel.count({ where: { projectId: project.id } }),
        getLimit(project.organizationId, "alerts", 100_000_000),
      ]);

      const form = withForm
        ? {
            slack: (await new NewAlertChannelPresenter().call(project.id)).slack,
            emailAlertsEnabled:
              env.ALERT_FROM_EMAIL !== undefined && env.ALERT_RESEND_API_KEY !== undefined,
          }
        : undefined;

      return json({
        channels,
        canWrite: canAcrossEnvironments(ability, "write", "alerts", allEnvironmentTypes),
        limits: { used, limit },
        form,
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to load alert channels", {
        organizationId: project.organizationId,
        projectId: project.id,
        userId: user.id,
        error,
      });
      throw error;
    }
  }
);

export const action = dashboardAction(
  { context: projectScope, authorization: { action: "write", resource: { type: "alerts" } } },
  async ({ request, user, ability }) => {
    const found = await findMemberProject(request, user.id);
    if (!found) {
      return json({ error: "Invalid request" }, { status: 400 });
    }
    requireAcrossEnvironments(ability, "write", "alerts", allEnvironmentTypes);
    const { project } = found;

    const submission = parseWithZod(await request.formData(), { schema: AlertChannelFormSchema });
    if (submission.status !== "success") {
      return json(submission.reply());
    }

    if (submission.value.type === "WEBHOOK") {
      try {
        await assertSafeWebhookUrl(submission.value.channelValue);
      } catch (error) {
        if (error instanceof UnsafeWebhookUrlError) {
          return json(submission.reply({ fieldErrors: { channelValue: [error.message] } }));
        }
        throw error;
      }
    }

    try {
      const [used, limit] = await Promise.all([
        prisma.projectAlertChannel.count({ where: { projectId: project.id } }),
        getLimit(project.organizationId, "alerts", 100_000_000),
      ]);
      if (used >= limit) {
        return json(submission.reply({ formErrors: ["This project is at its channel limit"] }));
      }

      const alertChannel = await new CreateAlertChannelService().call(
        project.externalRef,
        user.id,
        {
          ...formDataToAlertChannel(submission.value),
          alertTypes: [],
          environmentTypes: allEnvironmentTypes,
        }
      );
      if (!alertChannel) {
        return json(submission.reply({ formErrors: ["Failed to create alert channel"] }));
      }

      return json({
        channel: { id: alertChannel.id, name: alertChannel.name, type: alertChannel.type },
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      if (error instanceof ServiceValidationError) {
        return json(submission.reply({ formErrors: [error.message] }));
      }
      logger.error("Failed to create alert channel", {
        organizationId: project.organizationId,
        projectId: project.id,
        userId: user.id,
        error,
      });
      throw error;
    }
  }
);
