import type {
  Prisma,
  ProjectAlertChannelType,
  ProjectAlertType,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import pMap from "p-map";
import {
  LEGACY_ALERT_TYPE_LABEL,
  LEGACY_ALERT_TYPE_MIGRATION,
  LEGACY_ALERT_TYPES,
  type LegacyAlertType,
} from "~/components/alerts/legacyAlertChannels";
import { boundedIn, type PrismaClientOrTransaction } from "~/db.server";
import {
  listAlerts,
  type Alert,
  type AlertAttention,
  type AlertLifecycle,
} from "./storage/alertStore.server";

export const AGENT_ALERT_SCOPES = ["environment", "project", "organization"] as const;
export type AgentAlertScope = (typeof AGENT_ALERT_SCOPES)[number];

export const AGENT_ALERT_CHANNEL_SCOPES = ["project", "organization"] as const;
export type AgentAlertChannelScope = (typeof AGENT_ALERT_CHANNEL_SCOPES)[number];

export const AGENT_SCOPED_LIST_LIMIT = 200;
export const AGENT_SCOPE_MAX_PROJECTS = 50;
const AGENT_SCOPE_MAX_ENVIRONMENTS = 1000;
const ABILITY_CONCURRENCY = 5;

export type AgentScopeOrigin = {
  userId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
};

export type AlertReadAbility = (
  projectId: string
) => Promise<(envType?: RuntimeEnvironmentType) => boolean>;

export type ScopedAlert = {
  alert: Alert;
  project: { slug: string; name: string };
  environment: { slug: string; type: RuntimeEnvironmentType };
  channelIds: string[];
};

type ReadableProject = {
  id: string;
  slug: string;
  name: string;
  can: (envType?: RuntimeEnvironmentType) => boolean;
};

async function readableProjects(
  db: PrismaClientOrTransaction,
  origin: AgentScopeOrigin,
  wholeOrganization: boolean,
  readAbility: AlertReadAbility
): Promise<{ projects: ReadableProject[]; truncated: boolean }> {
  const where: Prisma.ProjectWhereInput = {
    organizationId: origin.organizationId,
    deletedAt: null,
    organization: { deletedAt: null, members: { some: { userId: origin.userId } } },
  };
  const select = { id: true, slug: true, name: true };
  const pinned = await db.project.findMany({ where: { ...where, id: origin.projectId }, select });
  const slots = AGENT_SCOPE_MAX_PROJECTS - pinned.length;
  const others = wholeOrganization
    ? await db.project.findMany({
        where: { ...where, id: { not: origin.projectId } },
        select,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: slots + 1,
      })
    : [];
  const considered = [...pinned, ...others.slice(0, slots)];
  const projects = await pMap(considered, async (p) => ({ ...p, can: await readAbility(p.id) }), {
    concurrency: ABILITY_CONCURRENCY,
  });
  return { projects, truncated: others.length > slots };
}

const ENVIRONMENT_TYPES: RuntimeEnvironmentType[] = [
  "DEVELOPMENT",
  "PREVIEW",
  "STAGING",
  "PRODUCTION",
];

function visibleEnvironmentWhere(userId: string): Prisma.RuntimeEnvironmentWhereInput {
  return {
    archivedAt: null,
    OR: [
      { type: { in: ["PREVIEW", "STAGING", "PRODUCTION"] } },
      { type: "DEVELOPMENT", orgMember: { userId } },
    ],
  };
}

function readableEnvironmentWhere(
  projects: ReadableProject[]
): Prisma.RuntimeEnvironmentWhereInput {
  const byTypes = new Map<string, { types: RuntimeEnvironmentType[]; projectIds: string[] }>();
  for (const project of projects) {
    const types = ENVIRONMENT_TYPES.filter((type) => project.can(type));
    if (types.length === 0) continue;
    const key = types.join();
    const group = byTypes.get(key) ?? { types, projectIds: [] };
    group.projectIds.push(project.id);
    byTypes.set(key, group);
  }
  return {
    OR: [...byTypes.values()].map((g) => ({
      type: { in: g.types },
      projectId: { in: boundedIn(g.projectIds) },
    })),
  };
}

export async function listScopedAlerts(
  db: PrismaClientOrTransaction,
  params: {
    origin: AgentScopeOrigin;
    scope: AgentAlertScope;
    attention?: AlertAttention;
    lifecycle?: AlertLifecycle;
    limit?: number;
    environmentLimit?: number;
  },
  readAbility: AlertReadAbility
): Promise<{ alerts: ScopedAlert[]; truncated: boolean }> {
  const { origin, scope } = params;
  const limit = params.limit ?? AGENT_SCOPED_LIST_LIMIT;
  const environmentLimit = params.environmentLimit ?? AGENT_SCOPE_MAX_ENVIRONMENTS;
  const scoped = await readableProjects(db, origin, scope === "organization", readAbility);
  const projectById = new Map(scoped.projects.map((p) => [p.id, p]));
  const readable = readableEnvironmentWhere(scoped.projects);
  if (readable.OR?.length === 0) return { alerts: [], truncated: scoped.truncated };

  const environmentRows = await db.runtimeEnvironment.findMany({
    where: {
      id: scope === "environment" ? origin.environmentId : undefined,
      organizationId: origin.organizationId,
      AND: [readable, visibleEnvironmentWhere(origin.userId)],
    },
    select: { id: true, slug: true, type: true, projectId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: environmentLimit + 1,
  });
  const environments = new Map(environmentRows.slice(0, environmentLimit).map((e) => [e.id, e]));
  const capped = scoped.truncated || environmentRows.length > environmentLimit;
  if (environments.size === 0) return { alerts: [], truncated: capped };

  const rows = await listAlerts(db, {
    organizationId: origin.organizationId,
    environmentIds: [...environments.keys()],
    attention: params.attention,
    lifecycle: params.lifecycle,
    limit: limit + 1,
  });

  const alerts: ScopedAlert[] = [];
  for (const alert of rows.slice(0, limit)) {
    const environment = environments.get(alert.environmentId);
    const project = environment && projectById.get(environment.projectId);
    if (!environment || !project || alert.projectId !== project.id) continue;
    alerts.push({
      alert,
      project: { slug: project.slug, name: project.name },
      environment: { slug: environment.slug, type: environment.type },
      channelIds: alert.notifiers.flatMap((n) => (n.type === "channel" ? [n.channelId] : [])),
    });
  }
  return { alerts, truncated: capped || rows.length > limit };
}

function legacyAlertsOf(alertTypes: ProjectAlertType[]) {
  return alertTypes.flatMap((type) => {
    if (!LEGACY_ALERT_TYPES.has(type)) return [];
    const legacyType = type as LegacyAlertType;
    const migration = LEGACY_ALERT_TYPE_MIGRATION[legacyType];
    return [
      {
        type: legacyType,
        label: LEGACY_ALERT_TYPE_LABEL[legacyType],
        migration: migration.kind,
        ...(migration.kind === "replace" ? { replaceWith: migration.capabilityKey } : {}),
      },
    ];
  });
}

export async function listScopedAlertChannels(
  db: PrismaClientOrTransaction,
  params: {
    origin: AgentScopeOrigin;
    scope: AgentAlertChannelScope;
    type?: ProjectAlertChannelType;
    legacy?: boolean;
    limit?: number;
  },
  readAbility: AlertReadAbility
) {
  const limit = params.limit ?? AGENT_SCOPED_LIST_LIMIT;
  const scoped = await readableProjects(
    db,
    params.origin,
    params.scope === "organization",
    readAbility
  );
  const projectById = new Map(scoped.projects.filter((p) => p.can()).map((p) => [p.id, p]));
  if (projectById.size === 0) return { channels: [], truncated: scoped.truncated };

  const rows = await db.projectAlertChannel.findMany({
    where: {
      projectId: { in: boundedIn([...projectById.keys()]) },
      type: params.type,
      alertTypes: params.legacy ? { hasSome: [...LEGACY_ALERT_TYPES] } : undefined,
    },
    select: {
      id: true,
      type: true,
      name: true,
      enabled: true,
      alertTypes: true,
      environmentTypes: true,
      projectId: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  return {
    channels: rows.slice(0, limit).flatMap((r) => {
      const project = projectById.get(r.projectId);
      if (!project) return [];
      return [
        {
          id: r.id,
          type: r.type,
          name: r.name,
          enabled: r.enabled,
          alertTypes: r.alertTypes,
          legacyAlerts: legacyAlertsOf(r.alertTypes),
          environmentTypes: r.environmentTypes,
          projectId: r.projectId,
          project: { slug: project.slug, name: project.name },
          createdAt: r.createdAt.toISOString(),
        },
      ];
    }),
    truncated: scoped.truncated || rows.length > limit,
  };
}
