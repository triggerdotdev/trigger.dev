import { z } from "zod";
import { json, redirect } from "@remix-run/server-runtime";
import { Form, useActionData, useNavigation, useSearchParams, useSubmit } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ArrowLeftIcon, BellSlashIcon } from "@heroicons/react/20/solid";
import { CheckMarkIcon } from "~/assets/icons/CheckMarkIcon";
import { EditPencilIcon } from "~/assets/icons/EditPencilIcon";
import { TrashIcon } from "~/assets/icons/TrashIcon";

import { useState } from "react";
import { alertInvestigatePrompt } from "~/components/dashboard-agent/investigate-prompts";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CodeBlock } from "~/components/code/CodeBlock";
import { DialogClose } from "@radix-ui/react-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { hasLegacyAlerts } from "~/components/alerts/hasLegacyAlerts.server";
import { LegacyAlertsBanner } from "~/components/alerts/LegacyAlertsBanner";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { MarkAsDropdown } from "~/components/primitives/MarkAsDropdown";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import {
  AlertDetailPresenter,
  type AlertDetail,
} from "~/presenters/v3/AlertDetailPresenter.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import { pickThresholdSeries } from "~/components/alerts/alertSeriesTypes";
import { GROUP_CAPABILITY_KEY, type NotifierRef } from "@internal/alert-contracts";
import { getAlert } from "~/v3/services/alerts/storage/alertStore.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import { editAlertGroup } from "~/v3/services/alerts/alertGroups.server";
import {
  groupScopeSummary,
  type AlertSeriesBundle,
  type GroupMemberTile,
} from "~/components/alerts/groupMembers";
import {
  EMPTY_SERIES,
  loadAlertSeries,
  loadGroupMemberTiles,
  resolveAlertDetailWindow,
} from "./alertDetailSeries.server";
import {
  AlertNotFoundError,
  AlertActionNotAllowedError,
  AlertActivationInvalidError,
  performAlertAction,
  activateAlert,
  editAlert,
  type AlertActionIntent,
} from "~/v3/services/alerts/alertActions.server";
import {
  NoNotifiersError,
  ChatNotifiersNotSupportedError,
  uniqueNotifiers,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import {
  buildNotifierOptions,
  parseNotifierKey,
  type EditableChannel,
} from "./editNotifierOptions";
import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  EnvironmentParamSchema,
  v3AlertPath,
  v3ErrorPath,
  v3ProjectAlertsPath,
  concurrencyQueuePath,
  v3StandardTaskPath,
} from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { AgentIcon } from "~/components/dashboard-agent/agent-identity";
import { GatedMenuItem } from "~/components/alerts/GatedMenuItem";
import { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import type { EditAlertPrefill } from "~/components/alerts/EditAlertTranscript";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { AlertActivityTable } from "~/components/alerts/AlertActivityTable";
import { activityRowLink } from "./activityRowLink";
import { AlertDetailChart, AlertDetailFilterBar } from "~/components/alerts/AlertDetailChart";
import { AlertDetailSidebar } from "~/components/alerts/AlertDetailSidebar";
import { GroupMemberTiles, GroupMembershipBanner } from "~/components/alerts/GroupMemberTiles";
import { availableAlertChannelWhere } from "~/v3/services/alerts/validateNotifierChannels.server";
import { EXPIRY_CHIPS } from "~/components/dashboard-agent/alert-creation/flow-state";
export const meta = pageMeta("Alert");

function parseTimestamp(value: string | null): number | undefined {
  const ms = value ? parseInt(value, 10) : NaN;
  return Number.isNaN(new Date(ms).getTime()) ? undefined : ms;
}

const AlertDetailParamSchema = EnvironmentParamSchema.extend({
  alertId: z.string(),
});

export const loader = dashboardLoader(
  {
    params: AlertDetailParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ params, user, request, ability }) => {
    const { projectParam, organizationSlug, envParam, alertId } = params;

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response(undefined, { status: 404, statusText: "Environment not found" });
    }
    if (!ability.can("read", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    const alertsListEnabled = await canUseAlertsList({
      orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
      user,
    });
    if (!alertsListEnabled) {
      throw new Response(undefined, { status: 404, statusText: "Not found" });
    }

    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? undefined;
    const fromStr = url.searchParams.get("from");
    const toStr = url.searchParams.get("to");
    const rawAlert = await getAlert(prisma, {
      id: alertId,
      projectId: project.id,
      environmentId: environment.id,
    });
    const detailWindow = resolveAlertDetailWindow({
      rawAlert,
      params: { period, from: parseTimestamp(fromStr), to: parseTimestamp(toStr) },
      maxWindowDays: env.ALERT_DETAIL_MAX_WINDOW_DAYS,
    });

    const presenter = new AlertDetailPresenter();
    const alert = await presenter.call({
      id: alertId,
      projectId: project.id,
      environmentId: environment.id,
      eventsWindow: detailWindow,
    });
    if (!alert || !rawAlert) {
      throw new Response(undefined, { status: 404, statusText: "Alert not found" });
    }

    const now = new Date();
    const isGroup = rawAlert.capabilityKey === GROUP_CAPABILITY_KEY;
    const memberIds = isGroup
      ? ((rawAlert.condition as { memberAlertIds?: string[] }).memberAlertIds ?? [])
      : [];
    let series: AlertSeriesBundle = EMPTY_SERIES;
    let memberTiles: GroupMemberTile[] = [];
    try {
      if (!isGroup) {
        series = await loadAlertSeries(prisma, {
          alertId,
          kind: alert.kind,
          rawAlert,
          window: detailWindow,
          project,
        });
      }
      if (isGroup) {
        memberTiles = await loadGroupMemberTiles(
          prisma,
          {
            memberIds,
            concurrency: Math.max(1, Math.floor(env.ALERTS_QUERY_CONCURRENCY_LIMIT / 2)),
            window: detailWindow,
            project,
            environmentId: environment.id,
          },
          {
            getDetail: (id) =>
              presenter.call({
                id,
                projectId: project.id,
                environmentId: environment.id,
                eventsWindow: detailWindow,
              }),
          }
        );
      }
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to load alert detail chart series", {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        userId: user.id,
        alertId,
        error,
      });
    }

    const parentGroup = rawAlert.groupId
      ? await getAlert(prisma, {
          id: rawAlert.groupId,
          projectId: project.id,
          environmentId: environment.id,
        })
      : null;

    const channels: EditableChannel[] = await prisma.projectAlertChannel.findMany({
      where: availableAlertChannelWhere({
        projectId: project.id,
        environmentType: environment.type,
      }),
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: "desc" },
    });

    return typedjson({
      ...(await hasLegacyAlerts(project.id)),
      alert: isGroup
        ? { ...alert, scopeSummary: groupScopeSummary(memberTiles.map((t) => t.name)) }
        : alert,
      ...series,
      memberTiles,
      memberOf: parentGroup ? { id: parentGroup.id, name: alertDisplayName(parentGroup) } : null,
      channels,
      now,
      window: detailWindow,
      createdAt: rawAlert.createdAt,
      permissions: {
        canWrite: ability.can("write", { type: "alerts", envType: environment.type }),
      },
    });
  }
);

const AlertActionFormSchema = z.object({
  intent: z.enum(["resolve", "stop", "delete", "activate", "edit", "ungroup"]),
  compositeMode: z.enum(["any", "all"]).optional(),
  notifierIds: z.string().optional(),
  expiresAt: z.string().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  respond: z.literal("json").optional(),
});

/** `undefined` keeps the stored expiry; "none" clears it. */
function parseExpiryField(value: string | undefined): Date | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

type NotifierCtx = {
  alertId: string;
  projectId: string;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  organizationId: string;
  userId: string;
};

async function checkChannels(
  refs: NotifierRef[],
  projectId: string,
  environmentType: RuntimeEnvironmentType
): Promise<string | null> {
  const channelIds = refs.flatMap((n) => (n.type === "channel" ? [n.channelId] : []));
  if (channelIds.length === 0) return null;
  const valid = await prisma.projectAlertChannel.findMany({
    where: {
      id: { in: boundedIn(channelIds) },
      ...availableAlertChannelWhere({ projectId, environmentType }),
    },
    select: { id: true },
  });
  const validIds = new Set(valid.map((c) => c.id));
  return channelIds.some((id) => !validIds.has(id)) ? "Channel is not available" : null;
}

async function resolveEditedNotifiers(
  notifierIds: string,
  ctx: NotifierCtx
): Promise<{ notifiers: NotifierRef[] } | { error: string }> {
  const rawKeys = notifierIds.split(",").filter(Boolean);
  const parsed = rawKeys
    .map(parseNotifierKey)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (parsed.length !== rawKeys.length) {
    return { error: "Invalid notifier" };
  }
  if (parsed.some((n) => n.type === "chat")) {
    return { error: new ChatNotifiersNotSupportedError().message };
  }
  const channelError = await checkChannels(
    parsed as NotifierRef[],
    ctx.projectId,
    ctx.environmentType
  );
  if (channelError) return { error: channelError };
  const notifiers = uniqueNotifiers(parsed as NotifierRef[]);
  if (notifiers.length === 0) {
    return { error: new NoNotifiersError().message };
  }
  return { notifiers };
}

export const action = dashboardAction(
  {
    params: AlertDetailParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "alerts" } },
  },
  async ({ params, user, request, ability }) => {
    const { projectParam, organizationSlug, envParam, alertId } = params;

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response(undefined, { status: 404, statusText: "Environment not found" });
    }
    if (!ability.can("write", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    const alertsListEnabled = await canUseAlertsList({
      orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
      user,
    });
    if (!alertsListEnabled) {
      throw new Response(undefined, { status: 404, statusText: "Not found" });
    }

    const formData = await request.formData();
    const submission = AlertActionFormSchema.safeParse(Object.fromEntries(formData));
    if (!submission.success) {
      return json({ error: "Invalid action" }, { status: 400 });
    }

    const ctx = {
      alertId,
      projectId: project.id,
      environmentId: environment.id,
      environmentType: environment.type,
      organizationId: project.organizationId,
      userId: user.id,
    };

    try {
      if (submission.data.intent === "activate") {
        const expiresAt = parseExpiryField(submission.data.expiresAt);
        if (expiresAt === "invalid") {
          return json({ error: "Pick an expiry in the future" }, { status: 400 });
        }
        let notifiers: NotifierRef[] | undefined;
        if (submission.data.notifierIds !== undefined) {
          const resolved = await resolveEditedNotifiers(submission.data.notifierIds, ctx);
          if ("error" in resolved) return json({ error: resolved.error }, { status: 400 });
          notifiers = resolved.notifiers;
        } else {
          const current = await getAlert(prisma, {
            id: alertId,
            projectId: project.id,
            environmentId: environment.id,
          });
          const channelError = await checkChannels(
            (current?.notifiers ?? []) as NotifierRef[],
            project.id,
            environment.type
          );
          if (channelError) return json({ error: channelError }, { status: 400 });
        }
        await activateAlert(prisma, {
          alertId,
          projectId: project.id,
          environmentId: environment.id,
          actorId: user.id,
          expiresAt,
          notifiers,
        });
        if (submission.data.name !== undefined) {
          await editAlert(prisma, {
            alertId,
            projectId: project.id,
            environmentId: environment.id,
            name: submission.data.name,
          });
        }
        if (submission.data.compositeMode) {
          await editAlertGroup(prisma, {
            groupId: alertId,
            projectId: project.id,
            environmentId: environment.id,
            compositeMode: submission.data.compositeMode,
          });
        }
      } else if (submission.data.intent === "edit") {
        const expiresAt = parseExpiryField(submission.data.expiresAt);
        if (expiresAt === "invalid" || (expiresAt && expiresAt.getTime() <= Date.now())) {
          return json({ error: "Pick an expiry in the future" }, { status: 400 });
        }
        let notifiers: NotifierRef[] | undefined;
        if (submission.data.notifierIds !== undefined) {
          const resolved = await resolveEditedNotifiers(submission.data.notifierIds, ctx);
          if ("error" in resolved) return json({ error: resolved.error }, { status: 400 });
          notifiers = resolved.notifiers;
        }
        if (submission.data.compositeMode) {
          await editAlertGroup(prisma, {
            groupId: alertId,
            projectId: project.id,
            environmentId: environment.id,
            compositeMode: submission.data.compositeMode,
          });
        }
        await editAlert(prisma, {
          alertId,
          projectId: project.id,
          environmentId: environment.id,
          notifiers,
          expiresAt,
          name: submission.data.name,
        });
      } else {
        await performAlertAction(prisma, {
          intent: submission.data.intent,
          alertId,
          projectId: project.id,
          environmentId: environment.id,
          actorId: user.id,
        });
      }
    } catch (error) {
      if (error instanceof AlertNotFoundError) {
        throw new Response(undefined, { status: 404, statusText: "Alert not found" });
      }
      if (
        error instanceof AlertActionNotAllowedError ||
        error instanceof AlertActivationInvalidError
      ) {
        return json({ error: error.message }, { status: 400 });
      }
      logger.error("Failed to update alert", {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        userId: user.id,
        alertId,
        error,
      });
      throw error;
    }

    if (submission.data.respond === "json") {
      return json({ ok: true });
    }
    if (submission.data.intent === "delete" || submission.data.intent === "ungroup") {
      return redirect(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam })
      );
    }
    return redirect(
      v3AlertPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }, alertId)
    );
  }
);

type AlertActionData = { error?: string };

// ---- Activity table ------------------------------------------------------------

// ---- Sidebar -------------------------------------------------------------------

function ActionError() {
  const actionData = useActionData<AlertActionData>();
  if (!actionData?.error) return null;
  return (
    <Callout variant="error" className="mt-1">
      {actionData.error}
    </Callout>
  );
}

type AlertPermissions = { canWrite: boolean };

export function DetailActionsMenu({
  alert,
  investigatePrompt,
  permissions,
  onEdit,
  onActivate,
}: {
  alert: AlertDetail;
  investigatePrompt: string;
  permissions: AlertPermissions;
  onEdit: () => void;
  onActivate: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [ungroupOpen, setUngroupOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const agent = useDashboardAgent();
  const submittingIntent = useSubmittingIntent();

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverVerticalEllipseTrigger aria-label="Alert actions" />
        <PopoverContent align="end" className="min-w-44 p-1">
          {alert.status.status === "inactive" ? (
            <>
              <GatedMenuItem
                allowed={permissions.canWrite}
                icon={CheckMarkIcon}
                leadingIconClassName="text-success"
                title="Activate"
                onClick={() => {
                  close();
                  onActivate();
                }}
              />
              <hr className="my-0.5 border-grid-bright" />
            </>
          ) : (
            <GatedMenuItem
              allowed={permissions.canWrite}
              icon={EditPencilIcon}
              title="Edit"
              onClick={() => {
                close();
                if (agent) agent.openEditAlert(editPrefill(alert));
                else onEdit();
              }}
            />
          )}
          {alert.status.status === "inactive" && (
            <GatedMenuItem
              allowed={permissions.canWrite}
              icon={TrashIcon}
              title="Delete"
              onClick={() => {
                close();
                setDeleteOpen(true);
              }}
            />
          )}
          {alert.capabilityKey === GROUP_CAPABILITY_KEY && (
            <GatedMenuItem
              allowed={permissions.canWrite}
              icon={TrashIcon}
              title="Ungroup"
              onClick={() => {
                close();
                setUngroupOpen(true);
              }}
            />
          )}
          {agent && (
            <PopoverMenuItem
              icon={AgentIcon}
              title="Investigate"
              onClick={() => {
                close();
                agent.openWith(investigatePrompt);
              }}
            />
          )}
        </PopoverContent>
      </Popover>
      <UngroupDialog open={ungroupOpen} onOpenChange={setUngroupOpen} />
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>Delete alert</DialogHeader>
          <DialogDescription className="mt-2">
            This permanently removes the alert and its activity history. This can't be undone.
          </DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary/medium">Cancel</Button>
            </DialogClose>
            <Form method="post">
              <Button
                type="submit"
                name="intent"
                value="delete"
                variant="danger/medium"
                LeadingIcon={TrashIcon}
                disabled={submittingIntent === "delete"}
              >
                {submittingIntent === "delete" ? "Deleting…" : "Delete"}
              </Button>
            </Form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function useSubmittingIntent(): AlertActionIntent | null {
  const navigation = useNavigation();
  return navigation.state !== "idle" && navigation.formMethod === "post"
    ? (navigation.formData?.get("intent") as AlertActionIntent | null)
    : null;
}

function UngroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submittingIntent = useSubmittingIntent();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>Ungroup alerts</DialogHeader>
        <DialogDescription className="mt-2">
          This deletes the group. Its alerts keep running and notify on their own again.
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary/medium">Cancel</Button>
          </DialogClose>
          <Form method="post">
            <Button
              type="submit"
              name="intent"
              value="ungroup"
              variant="danger/medium"
              disabled={submittingIntent === "ungroup"}
            >
              {submittingIntent === "ungroup" ? "Ungrouping…" : "Ungroup"}
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HeaderActions({
  status,
  permissions,
  onActivate,
}: {
  status: AlertDetail["status"];
  permissions: AlertPermissions;
  onActivate: () => void;
}) {
  const submittingIntent = useSubmittingIntent();
  const submit = useSubmit();

  const items = [
    status.status === "needs_attention" && {
      intent: "resolve",
      title: "Mark as Resolved",
      icon: CheckMarkIcon,
      iconClass: "text-success",
    },
    status.status === "active" && {
      intent: "stop",
      title: "Mark as Inactive",
      icon: BellSlashIcon,
      iconClass: undefined,
    },
    status.status === "inactive" && {
      intent: "activate",
      title: "Activate",
      icon: CheckMarkIcon,
      iconClass: "text-success",
    },
  ].filter((item) => item !== false);

  if (items.length === 0) return null;

  return (
    <MarkAsDropdown label="Mark Alert As" disabled={submittingIntent !== null}>
      {(close) =>
        items.map((item) =>
          item.intent === "activate" ? (
            <GatedMenuItem
              key={item.intent}
              allowed={permissions.canWrite}
              icon={item.icon}
              leadingIconClassName={item.iconClass}
              title={item.title}
              onClick={() => {
                close();
                onActivate();
              }}
            />
          ) : (
            <GatedMenuItem
              key={item.intent}
              allowed={permissions.canWrite}
              icon={item.icon}
              leadingIconClassName={item.iconClass}
              title={item.title}
              onClick={() => {
                submit({ intent: item.intent }, { method: "post" });
                close();
              }}
            />
          )
        )
      }
    </MarkAsDropdown>
  );
}

function DetailSidebar({
  alert,
  permissions,
  members,
  inGroup,
  onEdit,
  onActivate,
}: {
  alert: AlertDetail;
  permissions: AlertPermissions;
  members: { id: string; name: string }[];
  inGroup: boolean;
  onEdit: () => void;
  onActivate: () => void;
}) {
  const isGroup = alert.capabilityKey === GROUP_CAPABILITY_KEY;
  const agent = useDashboardAgent();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const activate = () => {
    if (agent) agent.openEditAlert({ ...editPrefill(alert), activate: true });
    else onActivate();
  };

  const objectLinkPath =
    alert.objectLink?.kind === "task"
      ? v3StandardTaskPath(organization, project, environment, alert.objectLink.taskIdentifier)
      : alert.objectLink?.kind === "queue"
        ? concurrencyQueuePath(organization, project, environment, {
            friendlyId: alert.objectLink.friendlyId,
          })
        : alert.objectLink?.kind === "fingerprint"
          ? v3ErrorPath(organization, project, environment, {
              fingerprint: alert.objectLink.fingerprint,
            })
          : undefined;

  return (
    <AlertDetailSidebar
      alert={alert}
      environmentTitle={environmentFullTitle(environment)}
      objectLinkPath={objectLinkPath}
      inGroup={inGroup}
      alerts={
        isGroup
          ? members.map((m) => ({
              id: m.id,
              name: m.name,
              path: v3AlertPath(organization, project, environment, m.id),
            }))
          : undefined
      }
      actions={
        <DetailActionsMenu
          alert={alert}
          investigatePrompt={alertInvestigatePrompt({
            alertId: alert.id,
            capabilityKey: alert.capabilityKey,
            environmentId: alert.environmentId,
            scope: alert.scope,
            name: alert.name,
            capabilityTitle: alert.capabilityTitle,
            conditionSummary: alert.conditionSummary,
            windowSec: alert.windowSec,
            latestRaisedEventFacts: alert.latestRaisedEventFacts,
          })}
          permissions={permissions}
          onEdit={onEdit}
          onActivate={activate}
        />
      }
      statusAction={
        <HeaderActions status={alert.status} permissions={permissions} onActivate={activate} />
      }
      footer={<ActionError />}
    />
  );
}

function ActivityPanel({ alert, now }: { alert: AlertDetail; now: Date }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-hidden">
      <div className="flex items-center justify-between pl-3 pr-2 pt-1">
        <Header3 className="mb-1 mt-2">Activity</Header3>
      </div>
      <AlertActivityTable
        alert={alert}
        now={now}
        rowLink={(event) => activityRowLink(alert, event, { organization, project, environment })}
      />
    </div>
  );
}

// ---- Edit panel ----------------------------------------------------------------

export function editPrefill(alert: AlertDetail): EditAlertPrefill {
  return {
    alertId: alert.id,
    name: alert.name,
    conditionSummary: alert.conditionSummary,
    scopeSummary: alert.scopeSummary,
    notifiers: alert.notifiers.map((n) => ({ key: n.key, label: n.label })),
    expiresAt: alert.expiresAt ? new Date(alert.expiresAt).toISOString() : null,
    compositeMode: alert.capabilityKey === GROUP_CAPABILITY_KEY ? alert.compositeMode : undefined,
  };
}

type ExpiryChoice = "none" | "24h" | "custom";

/** A past expiry starts unanswered so it has to be picked again. */
function initialExpiryChoice(expiresAt: Date | null): ExpiryChoice | undefined {
  if (!expiresAt) return "none";
  return new Date(expiresAt) > new Date() ? "custom" : undefined;
}

function toLocalInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function expiryField(choice: ExpiryChoice | undefined, custom: string): string | undefined {
  if (choice === "none") return "none";
  if (choice === "24h") return new Date(Date.now() + 24 * 3_600_000).toISOString();
  if (choice !== "custom" || !custom) return undefined;
  const date = new Date(custom);
  return Number.isNaN(date.getTime()) || date <= new Date() ? undefined : date.toISOString();
}

export function EditAlertPanel({
  alert,
  channels,
  activate,
  onCancel,
}: {
  alert: AlertDetail;
  channels: EditableChannel[];
  activate: boolean;
  onCancel: () => void;
}) {
  const navigation = useNavigation();
  const intent = activate ? "activate" : "edit";
  const submitting =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("intent") === intent;
  const [expiryChoice, setExpiryChoice] = useState(() => initialExpiryChoice(alert.expiresAt));
  const [customExpiry, setCustomExpiry] = useState(() =>
    expiryChoice === "custom" && alert.expiresAt ? toLocalInput(new Date(alert.expiresAt)) : ""
  );
  const expiresAt = expiryField(expiryChoice, customExpiry);
  const [name, setName] = useState(alert.name);
  const nameValid = name.trim().length >= 1 && name.trim().length <= 120;

  const options = buildNotifierOptions(channels, alert.notifiers);
  const currentKeys = new Set(alert.notifiers.map((n) => n.key));
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => currentKeys);

  function toggleNotifier(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const notifierIds = options
    .filter((o) => selectedKeys.has(o.key))
    .map((o) => o.key)
    .join(",");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <button
        type="button"
        onClick={onCancel}
        className="mb-3 flex items-center gap-1 text-xs text-text-dimmed transition hover:text-text-bright"
      >
        <ArrowLeftIcon className="size-3.5" />
        Cancel
      </button>
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <Header2>
          {activate ? "Activate" : "Edit"} — {alert.name}
        </Header2>
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="intent" value={intent} />
          <input type="hidden" name="notifierIds" value={notifierIds} />
          {expiresAt && <input type="hidden" name="expiresAt" value={expiresAt} />}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-dimmed">Condition</span>
            <CodeBlock
              code={alert.conditionSummary}
              showCopyButton={false}
              showLineNumbers={false}
              showOpenInModal={false}
              language="typescript"
              wrap
            />
          </div>
          {alert.capabilityKey === GROUP_CAPABILITY_KEY && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="pb-1.5 text-xs font-medium text-text-dimmed">Fires when</legend>
              {(["any", "all"] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="compositeMode"
                    value={value}
                    defaultChecked={alert.compositeMode === value}
                  />
                  <span className="text-text-bright">
                    {value === "any" ? "Any alert fires" : "All alerts fire"}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-dimmed">Scope</span>
            <span className="text-sm text-text-bright">{alert.scopeSummary}</span>
          </div>
          {
            <fieldset className="flex flex-col gap-1.5">
              <legend className="pb-1.5 text-xs font-medium text-text-dimmed">
                How long should it stay active?
              </legend>
              {EXPIRY_CHIPS.map((chip) => (
                <label key={chip.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="expiryChoice"
                    checked={expiryChoice === chip.value}
                    onChange={() => setExpiryChoice(chip.value as ExpiryChoice)}
                  />
                  <span className="text-text-bright">{chip.label}</span>
                </label>
              ))}
              {expiryChoice === "custom" && (
                <input
                  type="datetime-local"
                  aria-label="Expires at"
                  value={customExpiry}
                  onChange={(e) => setCustomExpiry(e.target.value)}
                  className="w-fit rounded border border-grid-bright bg-transparent px-2 py-1 text-sm text-text-bright"
                />
              )}
            </fieldset>
          }
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-dimmed">Notifiers</span>
            <div className="flex flex-col gap-1.5">
              {options.map((option) => (
                <label key={option.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(option.key)}
                    disabled={option.disabled && !selectedKeys.has(option.key)}
                    onChange={() => toggleNotifier(option.key)}
                    className="rounded border-grid-bright"
                  />
                  <span className={option.disabled ? "text-text-dimmed" : "text-text-bright"}>
                    {option.label}
                  </span>
                </label>
              ))}
              {options.length === 0 && (
                <span className="text-xs text-text-dimmed">No channels available</span>
              )}
            </div>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="pb-1.5 text-xs font-medium text-text-dimmed">Name</legend>
            <input
              type="text"
              name="name"
              aria-label="Name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-grid-bright bg-transparent px-2 py-1 text-sm text-text-bright"
            />
          </fieldset>
          {activate && <span className="text-xs text-text-dimmed">Watching resumes from now</span>}
          <ActionError />
          <div className="flex items-center gap-2 pt-2">
            <Button variant="secondary/small" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary/small"
              disabled={submitting || !nameValid || (activate && (!expiresAt || !notifierIds))}
            >
              {activate
                ? submitting
                  ? "Activating…"
                  : "Activate"
                : submitting
                  ? "Saving…"
                  : "Save changes"}
            </Button>
          </div>
        </Form>
      </div>
    </div>
  );
}

// ---- Main page -----------------------------------------------------------------

export default function Page() {
  const {
    hasMigratableLegacyAlerts: showLegacyBanner,
    alert,
    metricSeriesEntries,
    healthBands,
    componentSeries,
    limitTiles,
    channels,
    now,
    window: detailWindow,
    createdAt,
    permissions,
    queryGroups,
    querySeriesMode,
    memberTiles,
    memberOf,
  } = useTypedLoaderData<typeof loader>();
  const isGroup = alert.capabilityKey === GROUP_CAPABILITY_KEY;
  const [searchParams, setSearchParams] = useSearchParams();
  const editMode = searchParams.get("edit") === "1";
  const openEdit = (activate: boolean) =>
    setSearchParams((prev) => {
      prev.set("edit", "1");
      if (activate) prev.set("activate", "1");
      else prev.delete("activate");
      return prev;
    });
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const metricSeriesMap = new Map(metricSeriesEntries);
  const thresholdPick = pickThresholdSeries(metricSeriesMap, alert.scope.type);
  const thresholdHasReadings = (
    thresholdPick.multi ? [...thresholdPick.seriesMap.values()] : [thresholdPick.series]
  ).some((points) => points.some((p) => p.value !== null && p.value !== undefined));
  const displayAlert =
    alert.kind === "threshold" && !thresholdHasReadings ? { ...alert, reading: null } : alert;

  if (editMode) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle
            title={alert.name}
            backButton={{
              to: v3ProjectAlertsPath(organization, project, environment),
              text: "Alerts",
            }}
          />
        </NavBar>
        <PageBody>
          <EditAlertPanel
            alert={alert}
            channels={channels}
            activate={searchParams.get("activate") === "1" && alert.status.status === "inactive"}
            onCancel={() => {
              setSearchParams((prev) => {
                prev.delete("edit");
                prev.delete("activate");
                return prev;
              });
            }}
          />
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title={alert.name}
          backButton={{
            to: v3ProjectAlertsPath(organization, project, environment),
            text: "Alerts",
          }}
        />
      </NavBar>
      <div className="grid grid-rows-[auto_1fr] overflow-hidden">
        <div>
          <LegacyAlertsBanner show={showLegacyBanner} />
          {memberOf && (
            <GroupMembershipBanner
              name={memberOf.name}
              to={v3AlertPath(organization, project, environment, memberOf.id)}
            />
          )}
        </div>
        <PageBody scrollable={false} className="row-start-2">
          <ResizablePanelGroup orientation="horizontal" className="max-h-full">
            <ResizablePanel id="alert-main" min="300px">
              <div
                className={
                  isGroup
                    ? "flex h-full flex-col overflow-y-auto"
                    : "grid h-full grid-rows-[minmax(16rem,auto)_1fr] overflow-hidden"
                }
              >
                {isGroup ? (
                  <div className="flex items-center gap-2 border-b border-grid-bright px-3 py-2">
                    <AlertDetailFilterBar
                      lifetime={detailWindow.isLifetime ? detailWindow : undefined}
                    />
                  </div>
                ) : (
                  <AlertDetailChart
                    alert={alert}
                    metricSeriesMap={metricSeriesMap}
                    healthBands={healthBands}
                    componentSeries={componentSeries}
                    limitTiles={limitTiles}
                    window={detailWindow}
                    now={now}
                    createdAt={createdAt}
                    queryGroups={queryGroups}
                    querySeriesMode={querySeriesMode}
                  />
                )}
                {isGroup && (
                  <GroupMemberTiles tiles={memberTiles} window={detailWindow} now={now} />
                )}
                {isGroup ? (
                  <div className="h-96 shrink-0">
                    <ActivityPanel alert={alert} now={now} />
                  </div>
                ) : (
                  <ActivityPanel alert={alert} now={now} />
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle id="alert-detail-handle" />
            <ResizablePanel
              id="alert-detail"
              min="280px"
              default="380px"
              max="500px"
              isStaticAtRest
            >
              <DetailSidebar
                alert={displayAlert}
                permissions={permissions}
                members={memberTiles}
                inGroup={memberOf !== null}
                onEdit={() => openEdit(false)}
                onActivate={() => openEdit(true)}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </PageBody>
      </div>
    </PageContainer>
  );
}
