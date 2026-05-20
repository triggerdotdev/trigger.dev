// Inserts a `Session` row directly via Prisma so route auth tests can
// exercise routes that resolve a session by friendlyId or externalId.
//
// Note: not to be confused with `seedTestSession` in this directory —
// that helper builds a *dashboard cookie session* for cookie-auth tests.
// This helper builds an *agent-stream Session row* (the chat.agent
// runtime concept).

import type { PrismaClient, Session } from "@trigger.dev/database";
import { randomBytes } from "node:crypto";

function randomHex(len = 12): string {
  return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

export async function seedTestApiSession(
  prisma: PrismaClient,
  env: {
    id: string;
    type: string;
    organizationId: string;
    projectId: string;
  },
  overrides?: { taskIdentifier?: string; externalId?: string | null }
): Promise<Session> {
  const suffix = randomHex(8);
  return prisma.session.create({
    data: {
      id: `session_${suffix}`,
      friendlyId: `session_${suffix}`,
      // `null` lets a caller exercise the externalId-absent code path
      // (single-id auth resource); omit the override to get a unique
      // externalId for the multi-key path.
      externalId:
        overrides?.externalId === null
          ? null
          : overrides?.externalId ?? `ext_${suffix}`,
      type: "chat.agent",
      projectId: env.projectId,
      runtimeEnvironmentId: env.id,
      environmentType: env.type as Session["environmentType"],
      organizationId: env.organizationId,
      taskIdentifier: overrides?.taskIdentifier ?? `agent_${suffix}`,
      triggerConfig: { basePayload: { messages: [], trigger: "preload" } },
    },
  });
}
