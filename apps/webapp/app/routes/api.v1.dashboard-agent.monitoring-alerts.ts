import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { getAlert, listAlerts, resolveAlert } from "~/v3/services/alerts/storage/alertStore.server";
import {
  alertParamsSchema,
  behaviorSchema,
  conditionSchema,
  getCapability,
  listCapabilities,
  notifierRefSchema,
  validateConditionParams,
  type NotifierRef,
} from "@internal/alert-contracts";
import {
  resolveAgentAlertContext,
  type AgentAlertContextError,
} from "~/services/dashboardAgentAlertContext.server";
import { authorizeWatchEnvironmentById } from "~/services/dashboardAgentWatches.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import {
  authenticateDashboardAgent,
  authorizeAlerts,
  gateMonitoringAlerts,
} from "~/services/dashboardAgentMonitoringAlerts.server";
import { createAlertAndSchedule } from "~/v3/services/alerts/alertLifecycle.server";
import {
  createAlertFromDraft,
  InvalidQueryAlertError,
  QUERY_DOMAIN_ERRORS,
  type AlertDraftScope,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import { offeredCapabilities } from "~/v3/services/alerts/offeredCapabilities.server";
import { stateFields, validateAlertDraft } from "~/v3/services/alerts/validateAlertDraft.server";
import { validateAlertNotifiers } from "~/v3/services/alerts/validateAlertNotifiers.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import { resolveMonitoringAlertsEnvironment } from "~/services/monitoringAlertsApi.server";

function contextStatus(code: AgentAlertContextError) {
  return code === "environment_mismatch" ? 400 : 404;
}

const ListQuerySchema = z.object({
  chatId: z.string().min(1),
  attention: z.enum(["clear", "needs_attention"]).optional(),
  lifecycle: z.enum(["active", "completed", "expired", "stopped"]).optional(),
});

const CapabilitiesQuerySchema = z.object({
  area: z.enum(["queues", "runs", "health", "limits", "errors"]).optional(),
  curatedOnly: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const looseNotifierRef = z.discriminatedUnion("type", [
  z.object({ type: z.literal("channel"), channelId: z.string() }),
  z.object({
    type: z.literal("chat"),
    chatId: z.string().optional(),
    userId: z.string().optional(),
  }),
]);

const CreateBodySchema = z
  .object({
    chatId: z.string().min(1),
    capabilityKey: z.string().min(1),
    environment: z.enum(["dev", "staging", "prod", "preview"]).optional(),
    name: z.string().optional(),
    scope: alertParamsSchema.shape.scope.optional(),
    windowSec: alertParamsSchema.shape.windowSec,
    condition: conditionSchema,
    behavior: behaviorSchema.optional(),
    notifiers: z.array(looseNotifierRef).optional(),
    query: z.string().max(8192).optional(),
    signal: z
      .object({ mode: z.enum(["threshold", "absence", "match"]), measure: z.string().optional() })
      .optional(),
  })
  .refine(
    (v) => v.capabilityKey === "custom.query" || (v.query === undefined && v.signal === undefined),
    { message: "query and signal are only valid for the custom.query capability", path: ["query"] }
  );

const ResolveBodySchema = z.object({
  chatId: z.string().min(1),
  alertId: z.string().min(1),
});

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await authenticateDashboardAgent(request);
  if ("error" in auth) return auth.error;

  const params = Object.fromEntries(new URL(request.url).searchParams.entries());

  if (params.capabilities === "true") {
    const parsed = CapabilitiesQuerySchema.safeParse(params);
    if (!parsed.success) {
      return json({ error: "Invalid request" }, { status: 400 });
    }

    const environment = await authorizeWatchEnvironmentById({
      userId: auth.userId,
      environmentId: auth.environmentId,
    });
    if (!environment) {
      return json({ error: "Environment not found" }, { status: 404 });
    }
    if (!(await gateMonitoringAlerts(environment, auth.userId))) {
      return json({ error: "Monitoring alerts are not enabled for this project" }, { status: 403 });
    }

    const denied = await authorizeAlerts(request, environment, "read");
    if (denied) return denied;

    const caps = offeredCapabilities(
      listCapabilities({
        area: parsed.data.area,
        surface: "agent",
        curatedOnly: parsed.data.curatedOnly,
      })
    );
    return json({
      capabilities: caps.map((c) => ({
        key: c.key,
        title: c.title,
        area: c.area,
        group: c.group,
        signal: c.signal,
        allowedKinds: c.allowedKinds,
        allowedScopes: c.allowedScopes,
        unit: c.unit,
        curated: c.curated,
        supportedSignals: c.supportedSignals,
        components: c.binding.compositeOf,
        params: c.binding.params?.map((p) => ({
          key: p.key,
          label: p.label,
          unit: p.unit,
          default: p.default,
          min: p.min,
          max: p.max,
        })),
      })),
    });
  }

  const query = ListQuerySchema.safeParse(params);
  if (!query.success) {
    return json({ error: "Invalid request" }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({
    userId: auth.userId,
    environmentId: auth.environmentId,
    chatId: query.data.chatId,
  });
  if (!context.ok) {
    return json(
      { error: context.error, code: context.code },
      { status: contextStatus(context.code) }
    );
  }

  if (!(await gateMonitoringAlerts(context.environment, auth.userId))) {
    return json({ error: "Monitoring alerts are not enabled for this project" }, { status: 403 });
  }

  const denied = await authorizeAlerts(request, context.environment, "read");
  if (denied) return denied;

  const alerts = await listAlerts(prisma, {
    projectId: context.environment.project.id,
    environmentId: context.environment.id,
    attention: query.data.attention,
    lifecycle: query.data.lifecycle,
  });

  return json({
    alerts: alerts.map((a) => ({
      id: a.id,
      name: alertDisplayName(a),
      capabilityKey: a.capabilityKey,
      lifecycle: a.lifecycle,
      attention: a.attention,
      observedCondition: a.observedCondition,
      environmentId: a.environmentId,
      createdAt: a.createdAt.toISOString(),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const method = request.method.toUpperCase();
  if (method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await authenticateDashboardAgent(request);
  if ("error" in auth) return auth.error;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: "Invalid request" }, { status: 400 });
  }

  const actionType =
    rawBody && typeof rawBody === "object" && "alertId" in rawBody ? "resolve" : "create";

  if (actionType === "resolve") {
    const parsed = ResolveBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return json({ error: "Invalid request" }, { status: 400 });
    }

    const context = await resolveAgentAlertContext({
      userId: auth.userId,
      environmentId: auth.environmentId,
      chatId: parsed.data.chatId,
    });
    if (!context.ok) {
      return json(
        { error: context.error, code: context.code },
        { status: contextStatus(context.code) }
      );
    }

    if (!(await gateMonitoringAlerts(context.environment, auth.userId))) {
      return json({ error: "Monitoring alerts are not enabled for this project" }, { status: 403 });
    }

    const denied = await authorizeAlerts(request, context.environment, "write");
    if (denied) return denied;

    const alert = await getAlert(prisma, {
      id: parsed.data.alertId,
      projectId: context.environment.project.id,
      environmentId: context.environment.id,
    });
    if (!alert) {
      return json({ error: "Alert not found" }, { status: 404 });
    }

    const result = await resolveAlert(prisma, {
      id: parsed.data.alertId,
      actorId: auth.userId,
    });
    if (!result) {
      return json(
        { error: "Alert does not need attention or is already resolved" },
        { status: 409 }
      );
    }

    return json({ resolved: true, alertId: parsed.data.alertId });
  }

  const parsed = CreateBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return json(
      { error: "Invalid request", details: parsed.error.flatten(), issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const capability = getCapability(body.capabilityKey);
  const draftError = validateAlertDraft({
    capability,
    capabilityKey: body.capabilityKey,
    surface: "agent",
    conditionKind: body.condition.kind,
    quietWindowSec: body.condition.kind === "absence" ? body.condition.quietWindowSec : undefined,
    scope: body.scope,
    ...stateFields(body.condition),
  });
  if (draftError) {
    return json({ error: draftError.message }, { status: 400 });
  }

  if (capability && "params" in body.condition && body.condition.params) {
    const declared = capability.binding.params ?? [];
    try {
      validateConditionParams(body.condition.params, declared);
    } catch (e: unknown) {
      if (!(e instanceof Error)) throw e;
      return json({ error: (e as Error).message }, { status: 400 });
    }
  }

  const context = await resolveAgentAlertContext({
    userId: auth.userId,
    environmentId: auth.environmentId,
    chatId: body.chatId,
  });
  if (!context.ok) {
    return json(
      { error: context.error, code: context.code },
      { status: contextStatus(context.code) }
    );
  }
  const { environment } = context;

  if (body.environment) {
    const resolved = await resolveMonitoringAlertsEnvironment({
      projectId: environment.project.id,
      environment: body.environment,
      userId: auth.userId,
    });
    if (!resolved) {
      return json({ error: `Unknown environment: ${body.environment}` }, { status: 400 });
    }
    if (resolved.id !== environment.id) {
      return json(
        {
          error: "That environment isn't the one this chat is open in.",
          code: "environment_mismatch",
        },
        { status: 400 }
      );
    }
  }

  if (!(await gateMonitoringAlerts(environment, auth.userId))) {
    return json({ error: "Monitoring alerts are not enabled for this project" }, { status: 403 });
  }

  const denied = await authorizeAlerts(request, environment, "write");
  if (denied) return denied;

  const notifiers: NotifierRef[] =
    body.notifiers && body.notifiers.length > 0
      ? body.notifiers.map((n) =>
          n.type === "chat" && !n.chatId ? { ...n, chatId: body.chatId } : n
        )
      : [{ type: "chat", chatId: body.chatId }];

  for (const n of notifiers) {
    if (!notifierRefSchema.safeParse(n).success) {
      return json({ error: "Invalid notifier" }, { status: 400 });
    }
  }

  if (body.notifiers && body.notifiers.length > 0) {
    const notifierError = await validateAlertNotifiers({
      notifiers,
      projectId: environment.project.id,
      organizationId: environment.organizationId,
      userId: auth.userId,
      environmentType: environment.type,
    });
    if (notifierError) {
      return json({ error: notifierError.message }, { status: 400 });
    }
  }

  const scope = body.scope ?? { type: "all" as const };

  if (body.capabilityKey === "custom.query") {
    try {
      const alert = await createAlertFromDraft(prisma, {
        organizationId: environment.organizationId,
        projectId: environment.project.id,
        environmentId: environment.id,
        capabilityKey: body.capabilityKey,
        scope: scope as AlertDraftScope,
        condition: body.condition,
        expiresAt: body.behavior?.expiresAt ? new Date(body.behavior.expiresAt) : undefined,
        notifiers,
        name: body.name,
        createdBy: auth.userId,
        query: body.query,
        querySignalChoice: body.signal,
      });
      return json({
        created: true,
        alert: {
          id: alert.id,
          capabilityKey: alert.capabilityKey,
          lifecycle: alert.lifecycle,
          attention: alert.attention,
        },
      });
    } catch (error) {
      if (error instanceof InvalidQueryAlertError) {
        return json({ error: error.message }, { status: 422 });
      }
      if (QUERY_DOMAIN_ERRORS.some((cls) => error instanceof cls)) {
        return json({ error: (error as Error).message }, { status: 400 });
      }
      if (error instanceof Response) throw error;
      logger.error("Failed to create query alert via agent", {
        organizationId: environment.organizationId,
        projectId: environment.project.id,
        environmentId: environment.id,
        userId: auth.userId,
        error,
      });
      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  }

  try {
    const alert = await createAlertAndSchedule(prisma, {
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
      capabilityKey: body.capabilityKey,
      params: { environmentId: environment.id, scope, windowSec: body.windowSec },
      condition: body.condition as Record<string, unknown>,
      expiresAt: body.behavior?.expiresAt ? new Date(body.behavior.expiresAt) : undefined,
      notifiers,
      name: body.name,
      createdBy: auth.userId,
    });

    return json({
      created: true,
      alert: {
        id: alert.id,
        capabilityKey: alert.capabilityKey,
        lifecycle: alert.lifecycle,
        attention: alert.attention,
        ...stateFields(alert.condition as Parameters<typeof stateFields>[0]),
      },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to create monitoring alert via agent", {
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
      userId: auth.userId,
      error,
    });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
