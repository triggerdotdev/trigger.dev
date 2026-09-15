import {
  appendChatMessageOnce,
  chatExists,
  countUserMessages,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getSession,
  listChats,
  persistTurn,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect } from "vitest";

/**
 * Cross-tenant isolation for the chat store, against a real table (TRI-11166).
 *
 * The 2026-06-10 chat.agent audit flagged a cross-tenant read: a chat/session belongs to
 * one (org, user) pair, and every read that hands back its transcript or its session token
 * has to be scoped by that pair. A chatId from another tenant must read as not-found — never
 * as another tenant's transcript, and never as another tenant's public access token, which
 * is the credential a resumed session boots from.
 *
 * The store's own queries are the floor: the resource route scopes on project.organizationId
 * above this, but a bug there would still be caught here because these queries refuse a
 * foreign (org, user) outright rather than trusting the caller.
 */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

// Org A owns the chat. Org B and a same-org other user are the foreign tenants.
const ORG_A = "org_a";
const USER_A = "user_a";
const ORG_B = "org_b";
const USER_B = "user_b";
const CHAT = "chat_owned_by_a";

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

/** Seed a chat under org A with a transcript and a live session (its PAT is the credential). */
async function seedOwnedChat() {
  await createChat(agentDb, { id: CHAT, organizationId: ORG_A, userId: USER_A });
  await persistTurn(agentDb, {
    chatId: CHAT,
    messages: [textMessage("u1", "user"), textMessage("a1")],
    session: { publicAccessToken: "pat_secret_of_a", lastEventId: "42", runId: "run_a" },
  });
}

const foreignScopes = [
  { name: "another org", organizationId: ORG_B, userId: USER_B },
  // Same org, different user: a member of A's org still isn't the chat's owner.
  { name: "another user in the same org", organizationId: ORG_A, userId: USER_B },
  // Right user id, wrong org: the id alone must not carry across a tenant boundary.
  { name: "the owner's user id under another org", organizationId: ORG_B, userId: USER_A },
];

describe("getChatMessages is scoped to the owning (org, user)", () => {
  postgresTest(
    "the owner reads the transcript; every foreign tenant reads not-found",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedOwnedChat();

      const owned = await getChatMessages(agentDb, {
        chatId: CHAT,
        organizationId: ORG_A,
        userId: USER_A,
      });
      expect((owned as { id: string }[]).map((m) => m.id)).toEqual(["u1", "a1"]);

      for (const scope of foreignScopes) {
        // null is not-found. It must never be [] (a visible-but-empty chat) and never A's rows.
        const seen = await getChatMessages(agentDb, {
          chatId: CHAT,
          organizationId: scope.organizationId,
          userId: scope.userId,
        });
        expect(seen, scope.name).toBeNull();
      }
    },
    30_000
  );
});

describe("getSession never hands a foreign tenant the owner's access token", () => {
  postgresTest(
    "the owner gets the session; every foreign tenant gets null",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedOwnedChat();

      const owned = await getSession(agentDb, {
        chatId: CHAT,
        organizationId: ORG_A,
        userId: USER_A,
      });
      expect(owned?.publicAccessToken).toBe("pat_secret_of_a");

      for (const scope of foreignScopes) {
        const seen = await getSession(agentDb, {
          chatId: CHAT,
          organizationId: scope.organizationId,
          userId: scope.userId,
        });
        // A leaked session row would carry A's PAT — the resume credential. Refuse outright.
        expect(seen, scope.name).toBeNull();
      }
    },
    30_000
  );
});

describe("chatExists is the owner check the action routes gate on", () => {
  postgresTest(
    "true for the owner, false for every foreign tenant",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedOwnedChat();

      expect(
        await chatExists(agentDb, { chatId: CHAT, organizationId: ORG_A, userId: USER_A })
      ).toBe(true);
      for (const scope of foreignScopes) {
        expect(
          await chatExists(agentDb, {
            chatId: CHAT,
            organizationId: scope.organizationId,
            userId: scope.userId,
          }),
          scope.name
        ).toBe(false);
      }
    },
    30_000
  );
});

describe("listChats and countUserMessages never surface another tenant's chat", () => {
  postgresTest(
    "a foreign tenant lists nothing and counts nothing of the owner's",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedOwnedChat();

      const ownedList = await listChats(agentDb, { organizationId: ORG_A, userId: USER_A });
      expect(ownedList.map((c) => c.id)).toEqual([CHAT]);
      expect(await countUserMessages(agentDb, { organizationId: ORG_A, userId: USER_A })).toBe(1);

      for (const scope of foreignScopes) {
        const list = await listChats(agentDb, {
          organizationId: scope.organizationId,
          userId: scope.userId,
        });
        expect(list, scope.name).toEqual([]);
        expect(
          await countUserMessages(agentDb, {
            organizationId: scope.organizationId,
            userId: scope.userId,
          }),
          scope.name
        ).toBe(0);
      }
    },
    30_000
  );
});

describe("a foreign org cannot append to another tenant's chat", () => {
  postgresTest(
    "appendChatMessageOnce with a foreign org writes nothing and leaves the transcript intact",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedOwnedChat();

      const before = await getChatMessages(agentDb, {
        chatId: CHAT,
        organizationId: ORG_A,
        userId: USER_A,
      });

      // A chat id from another org appends nothing when the org is verified.
      const wroteForeignOrg = await appendChatMessageOnce(agentDb, {
        chatId: CHAT,
        userId: USER_A,
        organizationId: ORG_B,
        message: { id: "intruder", role: "assistant" },
      });
      expect(wroteForeignOrg).toBe(false);

      // And a foreign user, same org, is refused too.
      const wroteForeignUser = await appendChatMessageOnce(agentDb, {
        chatId: CHAT,
        userId: USER_B,
        organizationId: ORG_A,
        message: { id: "intruder2", role: "assistant" },
      });
      expect(wroteForeignUser).toBe(false);

      expect(
        await getChatMessages(agentDb, { chatId: CHAT, organizationId: ORG_A, userId: USER_A })
      ).toEqual(before);
    },
    30_000
  );
});
