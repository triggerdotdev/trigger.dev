import type { PrismaClientOrTransaction } from "~/db.server";
import type { Role } from "@trigger.dev/plugins";
import {
  type AttioClient,
  type AttioRecord,
  CREATED_WITH_ORG_MS,
  handleSyncFailure,
} from "./attioClient.server";

// Keeps Attio's view of who is in which workspace current: one Workspace membership record per
// user and org, and the Workspace's Users list. Jobs carry only ids and read the current state when
// they run, so a burst of changes to one membership collapses into one correct write.

const MEMBERSHIPS_OBJECT = "workspace_memberships";

// Attio select options on the membership's role. Custom roles share one option.
const SYSTEM_ROLE_TITLES = new Set(["Owner", "Admin", "Developer"]);
const CUSTOM_ROLE_TITLE = "Custom";

const JOIN_METHOD_TITLES: Record<string, string> = {
  created: "Created",
  invite: "Invite",
  sso_jit: "SSO",
  directory_sync: "Directory sync",
  manual: "Admin added",
};
const UNKNOWN_JOIN_METHOD = "Unknown";

// Thrown while the org's Workspace isn't in Attio yet (its own sync runs alongside); the job retries.
class WorkspaceNotSyncedError extends Error {
  readonly logLevel = "warn" as const;
  constructor(orgId: string) {
    super(`Attio workspace for ${orgId} not synced yet`);
  }
}

export type DesiredMembership = {
  userRecordId: string;
  workspaceRecordId: string;
  role: string;
  joinedAt: Date;
  joinMethod: string;
  isCreator: boolean;
  invitedByRecordId?: string;
};

// The legacy role mapping the RBAC plugin applies when a member has no role of their own.
export function roleTitle(role: Pick<Role, "name" | "isSystem"> | null, legacy: string): string {
  if (role)
    return role.isSystem && SYSTEM_ROLE_TITLES.has(role.name) ? role.name : CUSTOM_ROLE_TITLE;
  return legacy === "ADMIN" ? "Owner" : "Admin";
}

export function joinMethodTitle(joinMethod: string | null): string {
  return (joinMethod && JOIN_METHOD_TITLES[joinMethod]) || UNKNOWN_JOIN_METHOD;
}

// No creator column: the creator's membership is inserted with the org, so it shares its timestamp.
export function isCreatorMembership(
  joinMethod: string | null,
  memberCreatedAt: Date,
  orgCreatedAt: Date
): boolean {
  if (joinMethod) return joinMethod === "created";
  return Math.abs(memberCreatedAt.getTime() - orgCreatedAt.getTime()) < CREATED_WITH_ORG_MS;
}

const first = (record: AttioRecord | undefined, attr: string) => record?.values?.[attr]?.[0];
const refId = (record: AttioRecord | undefined, attr: string): string | undefined =>
  first(record, attr)?.target_record_id;
const time = (value: string | undefined) => (value ? Date.parse(value) : undefined);
const ref = (object: string, recordId: string) => [
  { target_object: object, target_record_id: recordId },
];

// Values that differ from the Attio record; empty when nothing changed. Never blanks invited_by.
export function membershipChanges(
  existing: AttioRecord | undefined,
  desired: DesiredMembership
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (refId(existing, "user") !== desired.userRecordId) {
    changes.user = ref("users", desired.userRecordId);
  }
  if (refId(existing, "workspace") !== desired.workspaceRecordId) {
    changes.workspace = ref("workspaces", desired.workspaceRecordId);
  }
  if (first(existing, "role")?.option?.title !== desired.role) changes.role = desired.role;
  if (time(first(existing, "joined_at")?.value) !== desired.joinedAt.getTime()) {
    changes.joined_at = desired.joinedAt.toISOString();
  }
  if (first(existing, "join_method")?.option?.title !== desired.joinMethod) {
    changes.join_method = desired.joinMethod;
  }
  if ((first(existing, "is_creator")?.value ?? false) !== desired.isCreator) {
    changes.is_creator = desired.isCreator;
  }
  if (desired.invitedByRecordId && refId(existing, "invited_by") !== desired.invitedByRecordId) {
    changes.invited_by = ref("users", desired.invitedByRecordId);
  }
  // A rejoin reopens the membership.
  if (first(existing, "left_at")?.value) changes.left_at = [];
  return changes;
}

async function findRecord(client: AttioClient, object: string, attr: string, value: string) {
  const [record] = await client.queryRecords(object, { [attr]: value }, 1);
  return record;
}

async function workspaceRecordId(client: AttioClient, orgId: string): Promise<string> {
  const id = (await findRecord(client, "workspaces", "workspace_id", orgId))?.id?.record_id;
  if (!id) throw new WorkspaceNotSyncedError(orgId);
  return id;
}

export type AttioMemberSync = { organizationId: string; userId: string };

type RoleReader = (params: { userId: string; organizationId: string }) => Promise<Role | null>;

// Each sync re-reads the database after writing and writes again if it changed meanwhile, so
// the last write to land always matches the database even when two runs of one job overlap.
const MAX_PASSES = 3;

// Thrown when the state keeps changing under the sync; the job retries later.
class StillChangingError extends Error {
  readonly logLevel = "warn" as const;
  constructor() {
    super(`Attio sync: state still changing after ${MAX_PASSES} passes`);
  }
}

async function untilStable<T>(read: () => Promise<T>, apply: (state: T) => Promise<void>) {
  let state = await read();
  for (let pass = 1; ; pass++) {
    await apply(state);
    const after = await read();
    if (JSON.stringify(after) === JSON.stringify(state)) return;
    if (pass >= MAX_PASSES) throw new StillChangingError();
    state = after;
  }
}

async function readMember(
  db: PrismaClientOrTransaction,
  getUserRole: RoleReader,
  { organizationId, userId }: AttioMemberSync
) {
  const org = await db.organization.findFirst({
    where: { id: organizationId },
    select: { createdAt: true, deletedAt: true },
  });
  const member = await db.orgMember.findFirst({
    where: { organizationId, userId },
    select: {
      createdAt: true,
      role: true,
      invitedById: true,
      joinMethod: true,
      user: { select: { email: true } },
    },
  });
  const role =
    member && org && !org.deletedAt
      ? roleTitle(await getUserRole({ userId, organizationId }), member.role)
      : null;
  return { org, member, role };
}

// Writes one membership: opens or updates it while the user is a member, closes it once they've
// left or the org is deleted. Writes nothing when Attio already matches.
export async function syncAttioMember(
  payload: AttioMemberSync,
  client: AttioClient,
  db: PrismaClientOrTransaction,
  getUserRole: RoleReader
) {
  const { organizationId, userId } = payload;
  const key = `${userId}:${organizationId}`;
  try {
    await untilStable(
      () => readMember(db, getUserRole, payload),
      async ({ org, member, role }) => {
        if (!org) return;
        const existing = await findRecord(client, MEMBERSHIPS_OBJECT, "membership_key", key);

        if (!member || org.deletedAt || !role) {
          if (existing?.id?.record_id && !first(existing, "left_at")?.value) {
            await client.assertRecord(MEMBERSHIPS_OBJECT, "membership_key", {
              membership_key: key,
              left_at: (org.deletedAt ?? new Date()).toISOString(),
            });
          }
          return;
        }

        const wsRecordId = await workspaceRecordId(client, organizationId);
        const userRecordId = await client.ensureUser(userId, member.user.email);
        if (!userRecordId) return;

        const invitedByRecordId = member.invitedById
          ? (await findRecord(client, "users", "user_id", member.invitedById))?.id?.record_id
          : undefined;

        const changes = membershipChanges(existing, {
          userRecordId,
          workspaceRecordId: wsRecordId,
          role,
          joinedAt: member.createdAt,
          joinMethod: joinMethodTitle(member.joinMethod),
          isCreator: isCreatorMembership(member.joinMethod, member.createdAt, org.createdAt),
          invitedByRecordId,
        });
        if (Object.keys(changes).length === 0) return;

        await client.assertRecord(MEMBERSHIPS_OBJECT, "membership_key", {
          membership_key: key,
          ...changes,
        });
      }
    );
  } catch (error) {
    handleSyncFailure("member", { organizationId, userId }, error);
  }
}

export type AttioWorkspaceMembersSync = { organizationId: string };

// Attio rejects an $in filter with more than 100 values.
const USER_QUERY_PAGE = 100;

async function readWorkspaceMembers(db: PrismaClientOrTransaction, organizationId: string) {
  const org = await db.organization.findFirst({
    where: { id: organizationId },
    select: { deletedAt: true },
  });
  if (!org || org.deletedAt) return null;
  return db.orgMember.findMany({
    where: { organizationId },
    select: { userId: true, user: { select: { email: true } } },
    orderBy: { userId: "asc" },
  });
}

// Rebuilds the Workspace's Users list from the org's current members. A deleted org keeps its last
// list.
export async function syncAttioWorkspaceMembers(
  payload: AttioWorkspaceMembersSync,
  client: AttioClient,
  db: PrismaClientOrTransaction
) {
  const { organizationId } = payload;
  try {
    await untilStable(
      () => readWorkspaceMembers(db, organizationId),
      async (members) => {
        if (!members) return;

        const workspace = await findRecord(client, "workspaces", "workspace_id", organizationId);
        const wsRecordId = workspace?.id?.record_id;
        if (!wsRecordId) throw new WorkspaceNotSyncedError(organizationId);

        const userIds = members.map((m) => m.userId);
        const found: AttioRecord[] = [];
        for (let i = 0; i < userIds.length; i += USER_QUERY_PAGE) {
          const page = userIds.slice(i, i + USER_QUERY_PAGE);
          found.push(
            ...(await client.queryRecords("users", { user_id: { $in: page } }, page.length))
          );
        }
        const recordIdByUser = new Map<string, string>();
        for (const record of found) {
          const id = record.id?.record_id;
          const userId = first(record, "user_id")?.value;
          if (id && userId) recordIdByUser.set(userId, id);
        }
        for (const member of members) {
          if (recordIdByUser.has(member.userId)) continue;
          const id = await client.ensureUser(member.userId, member.user.email);
          if (id) recordIdByUser.set(member.userId, id);
        }

        const want = [...new Set(recordIdByUser.values())].sort();
        const have = [
          ...new Set(
            (workspace?.values?.users ?? []).map((v: any) => v?.target_record_id).filter(Boolean)
          ),
        ].sort();
        if (want.length === have.length && want.every((id, i) => id === have[i])) return;

        await client.replaceRecordValues("workspaces", wsRecordId, {
          users: want.map((id) => ({ target_object: "users", target_record_id: id })),
        });
      }
    );
  } catch (error) {
    handleSyncFailure("workspace members", { organizationId }, error);
  }
}
