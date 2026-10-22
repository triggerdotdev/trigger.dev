import { parseWithZod } from "@conform-to/zod/v4";
import { BookOpenIcon } from "@heroicons/react/20/solid";
import { Outlet, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { type ActionFunctionArgs, defer, json, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { useEffect, useRef } from "react";
import { AlertsList } from "~/components/alerts/AlertsList";
import { hasLegacyAlerts } from "~/components/alerts/hasLegacyAlerts.server";
import { LegacyAlertChannelsPage } from "~/components/alerts/LegacyAlertChannelsPage";
import { LegacyAlertsBanner } from "~/components/alerts/LegacyAlertsBanner";
import { ManualAlertCreationDock } from "~/components/alerts/ManualAlertCreation";
import { createAlertPrompt } from "~/components/dashboard-agent/investigate-prompts";
import { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import {
  asArea,
  stripCreateSearchParams,
  type DraftPrefillParams,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  AlertChannelListPresenter,
  type AlertChannelListPresenterRecord,
} from "~/presenters/v3/AlertChannelListPresenter.server";
import type { AlertListRow } from "~/presenters/v3/alertListRow";
import { parseAlertsListSearchParams } from "~/components/alerts/alertsListFilters";
import {
  AlertsListPresenter,
  type AlertsListFilters,
} from "~/presenters/v3/AlertsListPresenter.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { rbac } from "~/services/rbac.server";
import { getImpersonationState } from "~/services/impersonation.server";
import { hasAdminDisplayAccess, requireUserId } from "~/services/session.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import {
  canAcrossEnvironments,
  requireAcrossEnvironments,
} from "~/v3/services/dashboardResourceAccess.server";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import {
  AlertActionNotAllowedError,
  AlertNotFoundError,
  performAlertAction,
} from "~/v3/services/alerts/alertActions.server";
import {
  authorizedChannelWhere,
  writeAuthorizedChannel,
  type AuthorizedChannel,
} from "~/v3/services/alerts/authorizedChannelWrite.server";
import {
  EnvironmentParamSchema,
  docsPath,
  v3AlertPath,
  v3AlertCreatePath,
  v3ProjectAlertChannelsPath,
  v3ProjectAlertsPath,
  v3ProjectLegacyAlertsPath,
} from "~/utils/pathBuilder";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { alertsAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";
import { isV2AlertId, isNewAlertAction } from "~/v3/services/alerts/alertIdRouting";

export const handle: Handle = {
  agentPageContext: (data) => alertsAgentPageContext(data),
};
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Alerts");

export function redirectChannelsView(
  request: Request,
  params: { organizationSlug: string; projectParam: string; envParam: string }
) {
  const search = new URL(request.url).searchParams;
  if (search.get("view") !== "channels" && search.get("modal") !== "channels") {
    return null;
  }
  search.delete("view");
  search.delete("modal");
  const query = search.toString();
  return redirect(
    `${v3ProjectAlertChannelsPath(
      { slug: params.organizationSlug },
      { slug: params.projectParam },
      { slug: params.envParam }
    )}${query ? `?${query}` : ""}`
  ) as unknown as Response;
}

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ params, user, request, ability }) => {
    const { projectParam, organizationSlug, envParam } = params;

    const channelsRedirect = redirectChannelsView(request, params);
    if (channelsRedirect) {
      return channelsRedirect;
    }

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response(undefined, {
        status: 404,
        statusText: "Project not found",
      });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response(undefined, {
        status: 404,
        statusText: "Environment not found",
      });
    }
    if (!ability.can("read", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    const alertsListEnabled = await canUseAlertsList({
      orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
      user,
    });

    if (!alertsListEnabled) {
      const presenter = new AlertChannelListPresenter();
      const canWrite = ability.can("write", { type: "alerts", envType: environment.type });
      const data = await presenter.call(project.id, environment.type, (channel) =>
        canAcrossEnvironments(ability, "write", "alerts", channel.environmentTypes)
      );
      return defer({ mode: "legacy" as const, canWrite, ...data }) as unknown as Response;
    }

    const { isViewingAsUser } = await getImpersonationState(request, user.id);
    const showAdminUi = hasAdminDisplayAccess({ ...user, isViewingAsUser });
    const agentAvailable = await canAccessDashboardAgent({
      userId: user.id,
      isAdmin: showAdminUi && user.admin,
      isImpersonating: showAdminUi && user.isImpersonating,
      organizationSlug,
      orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
    });

    const searchParams = new URL(request.url).searchParams;
    const listPresenter = new AlertsListPresenter();
    const {
      rows: alerts,
      page,
      totalPages,
      truncated,
    } = await listPresenter.call({
      environmentId: environment.id,
      page: Number(searchParams.get("page")) || 1,
      filters: {
        search: searchParams.get("search") ?? "",
        ...parseAlertsListSearchParams(searchParams),
      } as AlertsListFilters,
    });

    return defer({
      mode: "new" as const,
      alerts,
      ...(await hasLegacyAlerts(project.id)),
      page,
      totalPages,
      truncated,
      canWrite: ability.can("write", { type: "alerts", envType: environment.type }),
      canDelete: ability.can("delete", { type: "alerts", envType: environment.type }),
      agentAvailable,
    }) as unknown as Response;
  }
);

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), id: z.string() }),
  z.object({ action: z.literal("disable"), id: z.string() }),
  z.object({ action: z.literal("enable"), id: z.string() }),
  z.object({ action: z.literal("resolve"), id: z.string() }),
  z.object({ action: z.literal("stop"), id: z.string() }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    return json(submission.reply({ formErrors: ["Project not found"] }));
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json(submission.reply({ formErrors: ["Environment not found"] }));
  }

  const auth = await rbac.authenticateSession(request, {
    userId,
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const envType = environment.type;
  if (!auth.ok || !auth.ability.can("write", { type: "alerts", envType })) {
    throwPermissionDenied();
  }
  if (
    submission.value.action === "delete" &&
    !auth.ability.can("delete", { type: "alerts", envType })
  ) {
    throwPermissionDenied();
  }

  // Legacy channel enable/disable/delete only apply to the legacy channel list this route
  // renders when the new alerts UI is off; resolve is the opposite -- new-alerts only.
  const alertsListEnabled = await canUseAlertsList({
    orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
    userId,
  });
  const isV2Id = isV2AlertId(submission.value.id);
  if (isNewAlertAction(submission.value.action, submission.value.id) !== alertsListEnabled) {
    throw new Response(undefined, { status: 404, statusText: "Not found" });
  }
  const mutateChannel = async (
    write: (channel: AuthorizedChannel) => Promise<AuthorizedChannel | null>
  ) => {
    const outcome = await writeAuthorizedChannel(
      prisma,
      { id: submission.value.id, projectId: project.id },
      (environmentTypes) =>
        requireAcrossEnvironments(
          auth.ability,
          submission.value.action === "delete" ? "delete" : "write",
          "alerts",
          environmentTypes
        ),
      write
    );
    if (!outcome.found) {
      throw new Response(undefined, { status: 404, statusText: "Not found" });
    }
    return outcome.result;
  };
  const setEnabled = (enabled: boolean) =>
    mutateChannel(async (channel) => {
      const updated = await prisma.projectAlertChannel.updateMany({
        where: authorizedChannelWhere(channel),
        data: { enabled },
      });
      return updated.count > 0 ? channel : null;
    });

  switch (submission.value.action) {
    case "resolve":
    case "stop":
    case "delete": {
      if (!isV2Id && submission.value.action === "delete") {
        const alertChannel = await mutateChannel(async (channel) => {
          const deleted = await prisma.projectAlertChannel.deleteMany({
            where: authorizedChannelWhere(channel),
          });
          return deleted.count > 0 ? channel : null;
        });

        return redirectWithSuccessMessage(
          v3ProjectAlertsPath(
            { slug: organizationSlug },
            { slug: projectParam },
            { slug: envParam }
          ),
          request,
          `Deleted ${alertChannel.name} alert`
        );
      }

      try {
        await performAlertAction(prisma, {
          intent: submission.value.action as "resolve" | "stop" | "delete",
          alertId: submission.value.id,
          projectId: project.id,
          environmentId: environment.id,
          actorId: userId,
        });
      } catch (error) {
        if (error instanceof AlertNotFoundError) {
          throw new Response(undefined, { status: 404, statusText: "Alert not found" });
        }
        if (error instanceof AlertActionNotAllowedError) {
          return json(submission.reply({ formErrors: [error.message] }));
        }
        throw error;
      }

      const successMessages: Record<string, string> = {
        resolve: "Alert resolved",
        stop: "Alert stopped",
        delete: "Alert deleted",
      };

      return redirectWithSuccessMessage(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
        request,
        successMessages[submission.value.action] ?? "Done"
      );
    }
    case "disable": {
      const alertChannel = await setEnabled(false);

      return redirectWithSuccessMessage(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
        request,
        `Disabled ${alertChannel.name} alert`
      );
    }
    case "enable": {
      const alertChannel = await setEnabled(true);

      if (alertChannel.alertTypes.includes("ERROR_GROUP")) {
        await alertsWorker.enqueue({
          id: `evaluateErrorAlerts:${project.id}`,
          job: "v3.evaluateErrorAlerts",
          payload: {
            projectId: project.id,
            scheduledAt: Date.now(),
          },
        });
      }

      return redirectWithSuccessMessage(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
        request,
        `Enabled ${alertChannel.name} alert`
      );
    }
  }
};

type NewLoaderData = {
  mode: "new";
  alerts: AlertListRow[];
  page: number;
  totalPages: number;
  truncated: boolean;
  hasLegacyAlerts: boolean;
  hasMigratableLegacyAlerts: boolean;
  canWrite: boolean;
  canDelete: boolean;
  agentAvailable: boolean;
};

type LegacyLoaderData = {
  mode: "legacy";
  alertChannels: AlertChannelListPresenterRecord[];
  limits: { used: number; limit: number };
  canWrite: boolean;
};

type LoaderData = NewLoaderData | LegacyLoaderData;

export default function Page() {
  const data = useLoaderData() as unknown as LoaderData;

  if (data.mode === "new") {
    return (
      <NewAlertsPage
        alerts={data.alerts}
        hasMigratableLegacyAlerts={data.hasMigratableLegacyAlerts}
        page={data.page}
        totalPages={data.totalPages}
        truncated={data.truncated}
        hasLegacyAlerts={data.hasLegacyAlerts}
        canWrite={data.canWrite}
        canDelete={data.canDelete}
        agentAvailable={data.agentAvailable}
      />
    );
  }

  return <LegacyAlertChannelsPage alertChannels={data.alertChannels} limits={data.limits} />;
}

function NewAlertsPage({
  alerts,
  hasMigratableLegacyAlerts,
  page,
  totalPages,
  truncated,
  hasLegacyAlerts,
  canWrite,
  canDelete,
  agentAvailable,
}: {
  alerts: NewLoaderData["alerts"];
  hasMigratableLegacyAlerts: boolean;
  page: number;
  totalPages: number;
  truncated: boolean;
  hasLegacyAlerts: boolean;
  canWrite: boolean;
  canDelete: boolean;
  agentAvailable: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const agent = useDashboardAgent();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const wantCreate = searchParams.get("create") === "1";
  const listQuery = searchParams.toString();
  const pendingCreateRef = useRef<{
    area?: DraftPrefillParams["area"];
    capability?: string;
    scope?: string;
    scopeValue?: string;
  } | null>(
    wantCreate
      ? {
          area: asArea(searchParams.get("area") ?? undefined),
          capability: searchParams.get("capability") ?? undefined,
          scope: searchParams.get("scope") ?? undefined,
          scopeValue: searchParams.get("scopeValue") ?? undefined,
        }
      : null
  );
  useEffect(() => {
    if (wantCreate && !pendingCreateRef.current) {
      pendingCreateRef.current = {
        area: asArea(searchParams.get("area") ?? undefined),
        capability: searchParams.get("capability") ?? undefined,
        scope: searchParams.get("scope") ?? undefined,
        scopeValue: searchParams.get("scopeValue") ?? undefined,
      };
    }
  }, [wantCreate, searchParams]);

  useEffect(() => {
    const pending = pendingCreateRef.current;
    if (!pending || !agent) return;
    pendingCreateRef.current = null;
    agent.openCreateAlert(pending);
    setSearchParams((prev) => stripCreateSearchParams(prev), { replace: true });
  }, [agent, setSearchParams]);

  const manualCreate = wantCreate && !agentAvailable && !agent;
  const alertPath = (alertId: string) => v3AlertPath(organization, project, environment, alertId);

  return (
    <ManualAlertCreationDock
      open={manualCreate}
      prefill={{
        area: asArea(searchParams.get("area") ?? undefined),
        capability: searchParams.get("capability") ?? undefined,
        scope: searchParams.get("scope") ?? undefined,
        scopeValue: searchParams.get("scopeValue") ?? undefined,
      }}
      alertDetailPath={alertPath}
      onCreated={(alertId) =>
        alertId
          ? navigate(alertPath(alertId))
          : setSearchParams((prev) => stripCreateSearchParams(prev), { replace: true })
      }
      onClose={() => setSearchParams((prev) => stripCreateSearchParams(prev), { replace: true })}
    >
      <PageContainer>
        <NavBar>
          <PageTitle title="Alerts" />
          <PageAccessories>
            <WhenAgentUnavailable>
              <LinkButton
                LeadingIcon={BookOpenIcon}
                to={docsPath("v3/troubleshooting-alerts")}
                variant="docs/small"
              >
                Alerts docs
              </LinkButton>
            </WhenAgentUnavailable>
          </PageAccessories>
        </NavBar>
        <div className="grid grid-rows-[auto_1fr] overflow-hidden">
          <LegacyAlertsBanner show={hasMigratableLegacyAlerts} />
          <PageBody scrollable={false}>
            <AlertsList
              alerts={alerts}
              newAlertPath={v3AlertCreatePath(organization, project, environment)}
              newAlertPrompt={createAlertPrompt(environmentFullTitle(environment))}
              alertPath={alertPath}
              canWrite={canWrite}
              canDelete={canDelete}
              hasLegacyAlerts={hasLegacyAlerts}
              channelsTo={`${v3ProjectAlertChannelsPath(organization, project, environment)}${
                listQuery ? `?${listQuery}` : ""
              }`}
              legacyTo={v3ProjectLegacyAlertsPath(organization, project, environment)}
              page={page}
              totalPages={totalPages}
              truncated={truncated}
            />
            <Outlet />
          </PageBody>
        </div>
      </PageContainer>
    </ManualAlertCreationDock>
  );
}
