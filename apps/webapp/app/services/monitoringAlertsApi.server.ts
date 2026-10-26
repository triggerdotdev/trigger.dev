import {
  getCapability as registryGetCapability,
  type AlertCapability,
} from "@internal/alert-contracts";
import { sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { json } from "@remix-run/server-runtime";
import { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { RbacAbility } from "@trigger.dev/rbac";
import { $replica } from "~/db.server";
import {
  authIncludeBase,
  findEnvironmentBySlug,
  toAuthenticated,
} from "~/models/runtimeEnvironment.server";
import { anyResource } from "~/services/routeBuilders/apiBuilder.server";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";

export type MonitoringAlertsProject = {
  id: string;
  externalRef: string;
  organizationId: string;
  organizationSlug: string;
  organizationFeatureFlags: Record<string, unknown> | null;
};

export async function findMonitoringAlertsProject(
  projectRef: string,
  userId: string
): Promise<MonitoringAlertsProject | null> {
  const project = await $replica.project.findFirst({
    where: {
      externalRef: projectRef,
      deletedAt: null,
      organization: { deletedAt: null, members: { some: { userId } } },
    },
    select: {
      id: true,
      externalRef: true,
      organizationId: true,
      organization: { select: { slug: true, featureFlags: true } },
    },
  });

  if (!project) return null;

  return {
    id: project.id,
    externalRef: project.externalRef,
    organizationId: project.organizationId,
    organizationSlug: project.organization.slug,
    organizationFeatureFlags:
      (project.organization.featureFlags as Record<string, unknown> | null) ?? null,
  };
}

export async function monitoringAlertsRouteContext({ projectRef }: { projectRef: string }) {
  const project = await $replica.project.findFirst({
    where: { externalRef: projectRef, deletedAt: null },
    select: { id: true, organizationId: true },
  });
  return project ? { organizationId: project.organizationId, projectId: project.id } : {};
}

export async function findAlertEnvironmentType(environmentId: string) {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: environmentId },
    select: { type: true },
  });
  return environment?.type;
}

export async function canAccessAlertsIn(
  ability: RbacAbility,
  action: "read" | "write",
  environmentId: string
): Promise<boolean> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: environmentId },
    select: { type: true },
  });
  return !!environment && ability.can(action, { type: "alerts", envType: environment.type });
}

export function alertsInAnyEnvironment() {
  return anyResource(
    Object.values(RuntimeEnvironmentType).map((envType) => ({ type: "alerts", envType }))
  );
}

export function alertsEnvironmentForbidden(action: "read" | "write") {
  return json(
    {
      error: `You don't have permission to ${action === "read" ? "view" : "manage"} alerts in this environment`,
    },
    { status: 403 }
  );
}

export async function canUseMonitoringAlerts(
  project: MonitoringAlertsProject,
  userId: string
): Promise<boolean> {
  return canUseAlertsList({ orgFeatureFlags: project.organizationFeatureFlags, userId });
}

const ENVIRONMENT_SLUG_ALIASES: Record<string, string> = { staging: "stg" };

export async function resolveMonitoringAlertsEnvironment(params: {
  projectId: string;
  environment: string;
  branch?: string;
  userId: string;
}) {
  const slug = ENVIRONMENT_SLUG_ALIASES[params.environment] ?? params.environment;
  const environment = await findEnvironmentBySlug(params.projectId, slug, params.userId, $replica);
  const branch = sanitizeBranchName(params.branch);
  if (!environment || params.environment !== "preview" || !branch) return environment;

  const branchEnvironment = await $replica.runtimeEnvironment.findFirst({
    where: { parentEnvironmentId: environment.id, branchName: branch, archivedAt: null },
    include: authIncludeBase,
  });
  return branchEnvironment ? toAuthenticated(branchEnvironment) : null;
}

export type CapabilityLookup = (capabilityKey: string) => AlertCapability | undefined;

export const defaultCapabilityLookup: CapabilityLookup = registryGetCapability;
