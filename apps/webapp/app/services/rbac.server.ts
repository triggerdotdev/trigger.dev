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
