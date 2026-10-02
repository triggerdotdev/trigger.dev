import {
  chatExists,
  countChatsWithUnreadWork,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getSession,
  listChats,
  markChatRead,
  persistTurn,
  renameChat,
  softDeleteChat,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect } from "vitest";

/**
 * A chat someone else creates for the owner (an admin acting as the user, say) is stored
 * under the owner but must never show up in the owner's own history, unread count, or by
 * id. The user who created it sees it, alongside the owner's own chats, while acting as
 * the owner.
 */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

const ORG = "org_a";
const USER = "user_a";
const ACTING_USER = "acting_user_1";
const OTHER_ACTING_USER = "acting_user_2";
const OWN_CHAT = "chat_users_own";
const CREATED_FOR_OWNER_CHAT = "chat_created_for_owner";

async function boot(prisma: PrismaClient, connectionUri: string) {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  agentDb = agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function textMessage(id: string, role: "user" | "assistant" = "assistant") {
  return { id, role, parts: [{ type: "text", text: id }] };
}

async function seed() {
  await createChat(agentDb, { id: OWN_CHAT, organizationId: ORG, userId: USER });
  await createChat(agentDb, {
    id: CREATED_FOR_OWNER_CHAT,
    organizationId: ORG,
    userId: USER,
    createdByUserId: ACTING_USER,
  });
  for (const chatId of [OWN_CHAT, CREATED_FOR_OWNER_CHAT]) {
    await persistTurn(agentDb, {
      chatId,
      messages: [textMessage(`${chatId}_u`, "user"), textMessage(`${chatId}_a`)],
      session: { publicAccessToken: `pat_${chatId}`, lastEventId: "1", runId: `run_${chatId}` },
    });
  }
}

const user = { organizationId: ORG, userId: USER };
const acting = { ...user, actingUserId: ACTING_USER };
const otherActingUser = { ...user, actingUserId: OTHER_ACTING_USER };

describe("chats created for the owner by someone else", () => {
  postgresTest("stay out of the user's history", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    await seed();

    expect((await listChats(agentDb, user)).map((c) => c.id)).toEqual([OWN_CHAT]);
    expect(await countChatsWithUnreadWork(agentDb, user)).toBe(1);
  });

  postgresTest(
    "can't be opened, resumed or changed by the user",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seed();

      const target = { ...user, chatId: CREATED_FOR_OWNER_CHAT };
      expect(await chatExists(agentDb, target)).toBe(false);
      expect(await getChatMessages(agentDb, target)).toBeNull();
      expect(await getSession(agentDb, target)).toBeNull();

      await renameChat(agentDb, { ...target, title: "renamed by user" });
      await markChatRead(agentDb, target);
      const [seen] = (await listChats(agentDb, acting)).filter(
        (c) => c.id === CREATED_FOR_OWNER_CHAT
      );
      expect(seen!.title).not.toBe("renamed by user");
      expect(seen!.lastReadAt).toBeNull();
    }
  );

  postgresTest(
    "show to the acting who started them, next to the user's own chats",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seed();

      expect((await listChats(agentDb, acting)).map((c) => c.id).sort()).toEqual(
        [CREATED_FOR_OWNER_CHAT, OWN_CHAT].sort()
      );
      const target = { ...acting, chatId: CREATED_FOR_OWNER_CHAT };
      expect(await chatExists(agentDb, target)).toBe(true);
      expect(await getChatMessages(agentDb, target)).toHaveLength(2);
      expect((await getSession(agentDb, target))?.runId).toBe(`run_${CREATED_FOR_OWNER_CHAT}`);
    }
  );

  postgresTest(
    "stay hidden from a different acting user",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seed();

      expect((await listChats(agentDb, otherActingUser)).map((c) => c.id)).toEqual([OWN_CHAT]);
      expect(
        await chatExists(agentDb, { ...otherActingUser, chatId: CREATED_FOR_OWNER_CHAT })
      ).toBe(false);
    }
  );

  postgresTest(
    "can only be deleted by the acting user who started them",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seed();

      const target = { chatId: CREATED_FOR_OWNER_CHAT };
      expect((await softDeleteChat(agentDb, { ...user, ...target })).deleted).toBe(false);
      expect((await softDeleteChat(agentDb, { ...otherActingUser, ...target })).deleted).toBe(
        false
      );
      expect((await softDeleteChat(agentDb, { ...acting, ...target })).deleted).toBe(true);
      expect((await listChats(agentDb, acting)).map((c) => c.id)).toEqual([OWN_CHAT]);
    }
  );
});
