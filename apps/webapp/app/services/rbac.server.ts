import { prisma } from "~/db.server";
import plugin from "@trigger.dev/rbac";
import { env } from "~/env.server";
import { getUserId } from "./session.server";

async function getSessionUserId(request: Request): Promise<string | null> {
  const id = await getUserId(request);
  return id ?? null;
}

// plugin.create() is synchronous — returns a lazy controller that loads the enterprise plugin
// on first call. Top-level await is not used because CJS output format does not support it.
export const rbac = plugin.create(
  prisma,
  { getSessionUserId },
  { forceFallback: env.RBAC_FORCE_FALLBACK }
);

// Stable IDs for the system roles seeded by the enterprise/db migration
// (cloud/enterprise/db/drizzle/migrations/0000_legal_titanium_man.sql).
// They never change — anything that needs to set a default role at
// creation time keys off these. The OSS fallback's setUserRole returns
// `{ ok: false, error: "RBAC plugin not installed" }` and is safe to
// call with these ids; it just no-ops.
export const SYSTEM_ROLE_IDS = {
  owner: "sys_role_owner",
  admin: "sys_role_admin",
  member: "sys_role_member",
  viewer: "sys_role_viewer",
} as const;
