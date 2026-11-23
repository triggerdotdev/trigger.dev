import { boundedIn, type Prisma, type RuntimeEnvironmentType } from "@trigger.dev/database";
import type { PrismaReplicaClient } from "~/db.server";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { obfuscateApiKey } from "~/utils/apiKeys";
import {
  type CredentialReference,
  parseCredentialReference,
  rootKeyReference,
} from "./auditLogCredentials.server";

// The audit log page's filter menus. An organization can have hundreds of projects and thousands of
// environments and keys, so no menu is loaded whole: each shows its first items and searches for
// the rest. Everything is scoped to the organization, and environments and keys to one project.

/** Items a menu shows at a time. One more is read to know there are more. */
export const AUDIT_LOG_MENU_LIMIT = 25;
/** Rows the actor menu keeps for keys and tokens however many members match. */
const ACTOR_MENU_KEY_ROOM = 10;
/** Items the actor and project menus show when opened, before a search. */
export const AUDIT_LOG_OPENED_MENU_LIMIT = 10;

/** How far back rotated and revoked credentials are offered. */
const RETIRED_CREDENTIALS_DAYS = 90;

const AUDIT_LOG_MENUS = ["actor", "place", "credential"] as const;
export type AuditLogMenu = (typeof AUDIT_LOG_MENUS)[number];

/** An environment's name within its item's label, for the menu to colour like the rest of the app. */
export type AuditLogMenuEnvironment = { type: RuntimeEnvironmentType; name: string };
export type AuditLogMenuItem = {
  value: string;
  label: string;
  detail?: string;
  environment?: AuditLogMenuEnvironment;
};
type AuditLogMenuPage = { items: AuditLogMenuItem[]; more: boolean };

type MenuQuery = {
  organizationId: string;
  /** The user viewing the page: listed first among members, and their dev environment is offered. */
  viewerId: string;
  search: string;
  /** The picked project: its environments are listed first, and keys are listed for it. */
  projectId?: string;
};

export function isAuditLogMenu(value: string | null): value is AuditLogMenu {
  return (AUDIT_LOG_MENUS as readonly string[]).includes(value ?? "");
}

export async function auditLogMenu(
  replica: PrismaReplicaClient,
  menu: AuditLogMenu,
  query: MenuQuery
): Promise<AuditLogMenuPage> {
  switch (menu) {
    case "actor":
      return opened(query, await actors(replica, query));
    case "place":
      return opened(query, await places(replica, query));
    case "credential":
      return credentials(replica, query);
  }
}

const contains = (search: string) => ({ contains: search, mode: "insensitive" as const });

/** A menu as first opened shows a short list; typing searches everything. */
function opened(query: MenuQuery, menu: AuditLogMenuPage): AuditLogMenuPage {
  if (query.search) return menu;
  return {
    items: menu.items.slice(0, AUDIT_LOG_OPENED_MENU_LIMIT),
    more: menu.more || menu.items.length > AUDIT_LOG_OPENED_MENU_LIMIT,
  };
}

/**
 * Who acted, as the table's actor column shows it: members, then the keys and tokens that act
 * with no person behind them. A key or token is picked as a credential, so its rotations and the
 * public JWTs a root key signed are told apart as the credential filter does.
 */
async function actors(replica: PrismaReplicaClient, query: MenuQuery): Promise<AuditLogMenuPage> {
  const [people, keys] = await Promise.all([members(replica, query), credentials(replica, query)]);
  // Four characters may be a key's last 4: offer every event involving such a key, made with it or
  // changing it, including keys deleted since and personal access tokens, which aren't listed.
  const last4: AuditLogMenuItem[] = /^[A-Za-z0-9]{4}$/.test(query.search)
    ? [
        {
          value: `last4:${query.search}`,
          label: `Any key ending ••••••••${query.search}`,
          detail: "Used or changed",
        },
      ]
    : [];
  // Members never crowd out keys and tokens: a company domain can match every member's email.
  const keyRoom = Math.min(keys.items.length, ACTOR_MENU_KEY_ROOM);
  const shownPeople = people.items.slice(0, AUDIT_LOG_MENU_LIMIT - last4.length - keyRoom);
  const shownKeys = keys.items.slice(0, AUDIT_LOG_MENU_LIMIT - last4.length - shownPeople.length);
  return {
    items: [...last4, ...shownPeople, ...shownKeys],
    more:
      people.more ||
      keys.more ||
      shownPeople.length < people.items.length ||
      shownKeys.length < keys.items.length,
  };
}

function page(items: AuditLogMenuItem[], limit = AUDIT_LOG_MENU_LIMIT): AuditLogMenuPage {
  return { items: items.slice(0, limit), more: items.length > limit };
}

/** A member as the audit log names them: display name, then name. */
export function userName(user: { name: string | null; displayName: string | null }): string {
  return user.displayName || user.name || "Unknown user";
}

const memberFields = { id: true, name: true, displayName: true, email: true } as const;

/**
 * Members whose name or email contains the search. Postgres starts from the org's members: matching
 * users by name first would scan every user, as the planner can't estimate a `%…%` match.
 */
async function searchMembers(
  replica: PrismaReplicaClient,
  organizationId: string,
  search: string
): Promise<Array<{ id: string; name: string | null; displayName: string | null; email: string }>> {
  // As Prisma's `contains`: "%", "_" and "\" in the search match themselves.
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  return replica.$queryRaw`
    SELECT u."id", u."name", u."displayName", u."email"
    FROM "User" u
    WHERE u."id" = ANY(ARRAY(
      SELECT m."userId" FROM "OrgMember" m WHERE m."organizationId" = ${organizationId}
    ))
    AND (u."name" ILIKE ${pattern} OR u."displayName" ILIKE ${pattern} OR u."email" ILIKE ${pattern})
    ORDER BY u."name" ASC
    LIMIT ${AUDIT_LOG_MENU_LIMIT + 1}
  `;
}

async function members(
  replica: PrismaReplicaClient,
  { organizationId, viewerId, search }: MenuQuery
): Promise<AuditLogMenuPage> {
  const users = search
    ? await searchMembers(replica, organizationId, search)
    : (
        await replica.orgMember.findMany({
          where: { organizationId },
          select: { user: { select: memberFields } },
          orderBy: { user: { name: "asc" } },
          take: AUDIT_LOG_MENU_LIMIT + 1,
        })
      ).map((row) => row.user);
  const items = users.map((user) => ({
    value: user.id,
    label: userName(user),
    detail: user.email,
  }));
  // You first, when you're not searching, even when you sort after the first page.
  if (!search) {
    const viewer = items.findIndex((item) => item.value === viewerId);
    if (viewer > 0) {
      items.unshift(...items.splice(viewer, 1));
    } else if (viewer < 0) {
      const you = await replica.orgMember.findFirst({
        where: { organizationId, userId: viewerId },
        select: { user: { select: memberFields } },
      });
      if (you)
        items.unshift({ value: you.user.id, label: userName(you.user), detail: you.user.email });
    }
  }
  return page(items);
}

/**
 * Projects and their environments in one menu. Opened, it lists projects A–Z, each followed by its
 * environments; with a project picked, that project and its environments and branches come first.
 * Typing finds projects (each followed by its environments) and preview branches. An environment is a project's shared one or the viewer's own
 * development environment: other members' aren't offered (filter by the member instead).
 */
async function places(
  replica: PrismaReplicaClient,
  { organizationId, viewerId, search, projectId }: MenuQuery
): Promise<AuditLogMenuPage> {
  const liveProject = { organizationId, deletedAt: null };
  const sharedEnvironments = (projectIds: string[]) =>
    projectIds.length === 0
      ? Promise.resolve([])
      : replica.runtimeEnvironment.findMany({
          where: {
            projectId: { in: boundedIn(projectIds) },
            project: liveProject,
            archivedAt: null,
            branchName: null,
            OR: [{ type: { not: "DEVELOPMENT" } }, { orgMember: { userId: viewerId } }],
          },
          select: { id: true, type: true, projectId: true },
        });
  const branchSelect = {
    id: true,
    branchName: true,
    project: { select: { id: true, name: true } },
  } as const;
  const projectItem = (project: { id: string; name: string }, label = project.name) => ({
    value: `project:${project.id}`,
    label,
  });
  const environmentItem = (
    project: { id: string; name: string },
    id: string,
    name: string,
    type: RuntimeEnvironmentType
  ) => ({
    value: `environment:${project.id}:${id}`,
    label: `${project.name} · ${name}`,
    environment: { type, name },
  });
  const environmentsOf = (
    project: { id: string; name: string },
    shared: Awaited<ReturnType<typeof sharedEnvironments>>
  ) =>
    shared
      .filter((environment) => environment.projectId === project.id)
      .sort((a, b) => ENVIRONMENT_ORDER.indexOf(a.type) - ENVIRONMENT_ORDER.indexOf(b.type))
      .map((environment) =>
        environmentItem(
          project,
          environment.id,
          environment.type === "DEVELOPMENT"
            ? "Development (you)"
            : environmentTypeName(environment.type),
          environment.type
        )
      );

  if (search) {
    // "prod" finds every project's Production; Development only ever means the viewer's own.
    const types = ENVIRONMENT_ORDER.filter((type) =>
      (type === "DEVELOPMENT" ? "Development (you)" : environmentTypeName(type))
        .toLowerCase()
        .includes(search.toLowerCase())
    );
    const [projects, projectBranches, otherBranches, named] = await Promise.all([
      replica.project.findMany({
        where: { ...liveProject, OR: [{ name: contains(search) }, { slug: contains(search) }] },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: AUDIT_LOG_MENU_LIMIT + 1,
      }),
      // The picked project's branches first, so newer branches elsewhere can't push them out.
      projectId
        ? replica.runtimeEnvironment.findMany({
            where: {
              projectId,
              project: liveProject,
              archivedAt: null,
              type: "PREVIEW",
              branchName: contains(search),
            },
            select: branchSelect,
            orderBy: { createdAt: "desc" },
            take: AUDIT_LOG_MENU_LIMIT + 1,
          })
        : [],
      replica.runtimeEnvironment.findMany({
        where: {
          project: liveProject,
          archivedAt: null,
          type: "PREVIEW",
          branchName: contains(search),
        },
        select: branchSelect,
        orderBy: { createdAt: "desc" },
        take: AUDIT_LOG_MENU_LIMIT + 1,
      }),
      types.length === 0
        ? []
        : replica.runtimeEnvironment.findMany({
            where: {
              project: liveProject,
              archivedAt: null,
              branchName: null,
              // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- At most the four environment types.
              type: { in: types },
              OR: [{ type: { not: "DEVELOPMENT" } }, { orgMember: { userId: viewerId } }],
            },
            select: { id: true, type: true, project: { select: { id: true, name: true } } },
            orderBy: { project: { name: "asc" } },
            take: AUDIT_LOG_MENU_LIMIT + 1,
          }),
    ]);
    const shared = await sharedEnvironments(projects.map((project) => project.id));
    const inPicked = new Set(projectBranches.map((branch) => branch.id));
    const branches = [
      ...projectBranches,
      ...otherBranches.filter((branch) => !inPicked.has(branch.id)),
    ];
    const listed = new Set(shared.map((environment) => environment.id));
    return page([
      ...projects.flatMap((project) => [projectItem(project), ...environmentsOf(project, shared)]),
      ...branches.map((branch) =>
        environmentItem(branch.project, branch.id, branch.branchName ?? "Preview branch", "PREVIEW")
      ),
      ...named
        .filter((environment) => !listed.has(environment.id))
        .map((environment) =>
          environmentItem(
            environment.project,
            environment.id,
            environment.type === "DEVELOPMENT"
              ? "Development (you)"
              : environmentTypeName(environment.type),
            environment.type
          )
        ),
    ]);
  }

  const picked = projectId
    ? await replica.project.findFirst({
        where: { id: projectId, ...liveProject },
        select: { id: true, name: true },
      })
    : null;
  const [branches, projects] = await Promise.all([
    picked
      ? replica.runtimeEnvironment.findMany({
          where: {
            projectId: picked.id,
            archivedAt: null,
            type: "PREVIEW",
            branchName: { not: null },
          },
          select: branchSelect,
          orderBy: { createdAt: "desc" },
          take: AUDIT_LOG_MENU_LIMIT + 1,
        })
      : [],
    replica.project.findMany({
      where: { ...liveProject, ...(picked ? { id: { not: picked.id } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: AUDIT_LOG_MENU_LIMIT + 1,
    }),
  ]);
  if (picked) {
    const shared = await sharedEnvironments([picked.id]);
    return page([
      projectItem(picked, `All of ${picked.name}`),
      ...environmentsOf(picked, shared),
      ...branches.map((branch) =>
        environmentItem(picked, branch.id, branch.branchName ?? "Preview branch", "PREVIEW")
      ),
      ...projects.map((project) => projectItem(project)),
    ]);
  }
  // Nothing picked: each project with its environments, so one can be picked without searching.
  // Preview branches aren't listed, so if there are any, a search can find more.
  const [shared, branch] = await Promise.all([
    sharedEnvironments(projects.map((project) => project.id)),
    replica.runtimeEnvironment.findFirst({
      where: { project: liveProject, archivedAt: null, type: "PREVIEW", branchName: { not: null } },
      select: { id: true },
    }),
  ]);
  const listed = page(
    projects.flatMap((project) => [projectItem(project), ...environmentsOf(project, shared)])
  );
  return { ...listed, more: listed.more || branch !== null };
}

/**
 * The organization's access tokens and its keys: root keys (current, and rotated in the last 90
 * days) and additional keys. With a project, its keys are listed. Without one, the first projects'
 * current keys are listed, labelled with their project, and a search finds any key by its last 4,
 * name or project. Other members' development keys aren't offered: filter by the member instead. Personal access tokens aren't
 * listed: one belongs to a person and works in every org they're in, so this would name tokens
 * never used here. A link to one still filters.
 */
async function credentials(
  replica: PrismaReplicaClient,
  { organizationId, viewerId, search, projectId }: MenuQuery
): Promise<AuditLogMenuPage> {
  const since = new Date(Date.now() - RETIRED_CREDENTIALS_DAYS * 86_400_000);
  const now = Date.now();
  const retired = (revokedAt: Date | null, expiresAt: Date | null) =>
    revokedAt !== null || (expiresAt !== null && expiresAt.getTime() <= now);
  // Rotated keys are listed for a project or a search. Opened across the organization, the menu
  // shows the first projects' current keys; one rotated key is read only to say a search finds more.
  const listRotated = Boolean(projectId || search);
  // Branches use their parent's root key; other members' dev environments aren't offered.
  const keyEnvironments: Prisma.RuntimeEnvironmentWhereInput = {
    projectId,
    project: { organizationId },
    archivedAt: null,
    branchName: null,
    OR: [{ type: { not: "DEVELOPMENT" } }, { orgMember: { userId: viewerId } }],
  };
  // Without a project, a key is also found by its project's name, and a root key by its last 4.
  const orgSearch = projectId ? undefined : search || undefined;
  // Only an exact last 4, which the page already shows: matching any longer ending of a root key's
  // secret would let a search uncover the rest of it a character at a time. Any case, as typed.
  const last4Search = /^[A-Za-z0-9]{4}$/.test(search) ? search : undefined;
  const rootLast4 = orgSearch ? last4Search : undefined;
  const byRootLast4 = (last4: string | undefined) =>
    last4 ? [{ apiKey: { endsWith: last4, mode: "insensitive" as const } }] : [];
  const withProjectName = { project: { select: { name: true } } } as const;

  const rotatedSelect = {
    apiKey: true,
    runtimeEnvironmentId: true,
    runtimeEnvironment: { select: { type: true, ...withProjectName } },
  } as const;
  const [oats, roots, rotatedRows, rotatedByLast4, keys] = await Promise.all([
    replica.organizationAccessToken.findMany({
      where: {
        organizationId,
        OR: [{ revokedAt: null }, { revokedAt: { gte: since } }],
        ...(search ? { name: contains(search) } : {}),
      },
      select: { id: true, name: true, revokedAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
      take: AUDIT_LOG_MENU_LIMIT + 1,
    }),
    replica.runtimeEnvironment.findMany({
      where: {
        AND: [
          keyEnvironments,
          ...(orgSearch
            ? [
                {
                  OR: [...byRootLast4(rootLast4), { project: { name: contains(orgSearch) } }],
                },
              ]
            : []),
        ],
      },
      select: { id: true, type: true, apiKey: true, ...withProjectName },
      orderBy: { project: { name: "asc" } },
      take: projectId ? undefined : AUDIT_LOG_MENU_LIMIT + 1,
    }),
    replica.revokedApiKey.findMany({
      where: {
        createdAt: { gte: since },
        runtimeEnvironment: keyEnvironments,
        ...(orgSearch
          ? {
              OR: [
                ...byRootLast4(rootLast4),
                { runtimeEnvironment: { project: { name: contains(orgSearch) } } },
              ],
            }
          : {}),
      },
      select: {
        apiKey: true,
        runtimeEnvironmentId: true,
        runtimeEnvironment: { select: { type: true, ...withProjectName } },
      },
      orderBy: { createdAt: "desc" },
      take: listRotated ? AUDIT_LOG_MENU_LIMIT + 1 : 1,
    }),
    // In a project, the latest rotations are matched by their labels below; a last 4 is also
    // matched here, so an older rotation isn't cut off by that limit.
    projectId && last4Search
      ? replica.revokedApiKey.findMany({
          where: {
            createdAt: { gte: since },
            runtimeEnvironment: keyEnvironments,
            apiKey: { endsWith: last4Search, mode: "insensitive" },
          },
          select: rotatedSelect,
          orderBy: { createdAt: "desc" },
          take: AUDIT_LOG_MENU_LIMIT + 1,
        })
      : [],
    replica.apiKey.findMany({
      // A build's own deploy key is listed as Trigger.dev infrastructure, not as a credential.
      where: {
        issuedBy: "USER",
        runtimeEnvironment: keyEnvironments,
        OR: [{ revokedAt: null }, { revokedAt: { gte: since } }],
        ...(search
          ? {
              AND: [
                {
                  OR: [
                    { name: contains(search) },
                    { lastFour: contains(search) },
                    ...(orgSearch
                      ? [{ runtimeEnvironment: { project: { name: contains(orgSearch) } } }]
                      : []),
                  ],
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        lastFour: true,
        revokedAt: true,
        expiresAt: true,
        runtimeEnvironment: { select: { type: true, ...withProjectName } },
      },
      orderBy: { createdAt: "desc" },
      take: AUDIT_LOG_MENU_LIMIT + 1,
    }),
  ]);

  const rotated = listRotated ? [...rotatedByLast4, ...rotatedRows] : [];
  // Picked from one project, a key needs no project in its label; across the org, it does.
  const inProject = (name: string, label: string) => (projectId ? label : `${name} · ${label}`);
  const matches = (label: string) =>
    !projectId || !search || label.toLowerCase().includes(search.toLowerCase());
  // A rotated key is named by its environment and last 4, so one that shares the current key's
  // last 4 (or an earlier rotation's) is the same item.
  const rootValues = new Set(roots.map((root) => rootKeyReference(root.id, root.apiKey)));
  const items = page([
    ...roots
      .sort(
        (a, b) =>
          a.project.name.localeCompare(b.project.name) ||
          ENVIRONMENT_ORDER.indexOf(a.type) - ENVIRONMENT_ORDER.indexOf(b.type)
      )
      .map((root) => ({
        value: rootKeyReference(root.id, root.apiKey),
        label: inProject(root.project.name, obfuscateApiKey(root.type, root.apiKey.slice(-4))),
        detail: rootKeyDetail(root.type),
      }))
      .filter((item) => matches(`${item.label} ${item.detail}`)),
    ...keys.map((key) => ({
      value: `key:${key.id}`,
      label: inProject(
        key.runtimeEnvironment.project.name,
        obfuscateApiKey(key.runtimeEnvironment.type, key.lastFour, "additional")
      ),
      detail: retired(key.revokedAt, key.expiresAt) ? `${key.name} (inactive)` : key.name,
    })),
    ...oats.map((oat) => ({
      value: `oat:${oat.id}`,
      label: `Org token · ${oat.name}`,
      detail: retired(oat.revokedAt, oat.expiresAt) ? "Inactive" : undefined,
    })),
    ...rotated
      .map((key) => ({
        value: rootKeyReference(key.runtimeEnvironmentId, key.apiKey),
        label: inProject(
          key.runtimeEnvironment.project.name,
          obfuscateApiKey(key.runtimeEnvironment.type, key.apiKey.slice(-4))
        ),
        detail: `${rootKeyDetail(key.runtimeEnvironment.type)} (rotated)`,
      }))
      .filter((item) => {
        if (rootValues.has(item.value)) return false;
        rootValues.add(item.value);
        return true;
      })
      .filter((item) => matches(`${item.label} ${item.detail}`)),
  ]);
  // Without a project or a search, keys exist but aren't listed: say there's more to find.
  return { ...items, more: items.more || (!listRotated && rotatedRows.length > 0) };
}

/** The labels of the values a link or the URL picked, which a menu's first page may not include. */
export async function auditLogSelectedLabels(
  replica: PrismaReplicaClient,
  organizationId: string,
  selected: {
    actorId?: string;
    projectId?: string;
    environmentId?: string;
    credential?: string;
    /** The picked personal access token has events in this organization: see the presenter. */
    patActedHere?: boolean;
  }
): Promise<{
  actor?: string;
  place?: string;
  /** The picked environment's name within `place`, to colour. */
  placeEnvironment?: AuditLogMenuEnvironment;
  credential?: string;
}> {
  const reference = parseCredentialReference(selected.credential);
  const [user, project, environment, credential] = await Promise.all([
    // Only a current member is named: a link can carry any user id. Anyone else shows as a former
    // member, as the menu does.
    selected.actorId
      ? replica.user.findFirst({
          where: { id: selected.actorId, orgMemberships: { some: { organizationId } } },
          select: { name: true, displayName: true },
        })
      : null,
    selected.projectId
      ? replica.project.findFirst({
          where: { id: selected.projectId, organizationId },
          select: { name: true },
        })
      : null,
    selected.environmentId
      ? replica.runtimeEnvironment.findFirst({
          where: { id: selected.environmentId, project: { organizationId } },
          select: {
            type: true,
            branchName: true,
            project: { select: { name: true } },
            orgMember: { select: { user: { select: { name: true, displayName: true } } } },
          },
        })
      : null,
    reference
      ? credentialLabel(replica, organizationId, reference, selected.patActedHere ?? false)
      : null,
  ]);

  const environmentName = environment
    ? (environment.branchName ??
      (environment.type === "DEVELOPMENT" && environment.orgMember
        ? `Development (${userName(environment.orgMember.user)})`
        : environmentTypeName(environment.type)))
    : undefined;
  return {
    actor: user ? userName(user) : undefined,
    place:
      environment && environmentName
        ? `${environment.project.name} · ${environmentName}`
        : project?.name,
    placeEnvironment:
      environment && environmentName
        ? { type: environment.type, name: environmentName }
        : undefined,
    credential: credential ?? undefined,
  };
}

async function credentialLabel(
  replica: PrismaReplicaClient,
  organizationId: string,
  reference: CredentialReference,
  patActedHere: boolean
): Promise<string | null> {
  const inOrg = { project: { organizationId } };
  switch (reference.kind) {
    case "root": {
      const root = await replica.runtimeEnvironment.findFirst({
        where: { id: reference.id, ...inOrg },
        select: { type: true, apiKey: true },
      });
      if (!root) return null;
      const current = root.apiKey.slice(-4);
      const last4 = reference.last4 ?? current;
      // Any other last 4 is a key the environment had before a rotation.
      return `${obfuscateApiKey(root.type, last4)}${last4 === current ? "" : " (rotated)"}`;
    }
    case "key": {
      const key = await replica.apiKey.findFirst({
        where: { id: reference.id, runtimeEnvironment: inOrg },
        select: { lastFour: true, runtimeEnvironment: { select: { type: true } } },
      });
      return key ? obfuscateApiKey(key.runtimeEnvironment.type, key.lastFour, "additional") : null;
    }
    case "oat": {
      const oat = await replica.organizationAccessToken.findFirst({
        where: { id: reference.id, organizationId },
        select: { name: true },
      });
      return oat ? `Org token · ${oat.name}` : null;
    }
    case "pat": {
      // A member's token used only in other organizations would leak its name here.
      if (!patActedHere) return "Personal access token";
      const pat = await replica.personalAccessToken.findFirst({
        where: { id: reference.id, user: { orgMemberships: { some: { organizationId } } } },
        select: { name: true },
      });
      return pat ? `PAT · ${pat.name}` : null;
    }
  }
}

function rootKeyDetail(type: RuntimeEnvironmentType) {
  return type === "DEVELOPMENT"
    ? "Your development root key"
    : `${environmentTypeName(type)} root key`;
}

const ENVIRONMENT_ORDER: RuntimeEnvironmentType[] = [
  "PRODUCTION",
  "STAGING",
  "PREVIEW",
  "DEVELOPMENT",
];

/** An environment type's name, as the dashboard's environment labels show it. */
const environmentTypeName = (type: RuntimeEnvironmentType) => environmentFullTitle({ type });
