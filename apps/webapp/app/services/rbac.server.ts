import { prisma } from "~/db.server";
import plugin from "@trigger.dev/rbac";
import { getUserId } from "./session.server";

async function getSessionUserId(request: Request): Promise<string | null> {
  const id = await getUserId(request);
  return id ?? null;
}

export const rbac = await plugin.create(prisma, { getSessionUserId });
