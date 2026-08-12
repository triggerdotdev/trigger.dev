import {
  createChat,
  createDashboardAgentDb,
  getAgentMessageUsage,
  incrementAgentMessageUsage,
  softDeleteChat,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentTurnCountsAgainstQuota,
  checkAgentMessageQuota,
  currentAgentMessagePeriod,
  resolveAgentMessageQuota,
  UNLIMITED_AGENT_MESSAGES,
} from "~/services/dashboardAgentQuota.server";

/**
 * Server-side agent message quota (TRI-12863): a per-(org, period) counter that a deleted chat
 * can't lower, a pure at/over/under rule, and a resolver that fails open when the limit is
 * absent (self-hosted) or the counter read throws.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");

async function applyAgentSchema(prisma: PrismaClient) {
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await prisma.$executeRawUnsafe(trimmed);
    }
  }
}

const ORG = "org_quota";
const USER = "user_quota";

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string): Promise<DashboardAgentDb> {
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  return agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("checkAgentMessageQuota", () => {
  it("is not reached under the limit", () => {
    expect(checkAgentMessageQuota({ used: 5, limit: 20 })).toEqual({ reached: false });
  });

  it("is reached at the limit", () => {
    // Control break: `>=`. Flip to `>` and this fails.
    expect(checkAgentMessageQuota({ used: 20, limit: 20 })).toEqual({ reached: true });
  });

  it("is reached over the limit", () => {
    expect(checkAgentMessageQuota({ used: 21, limit: 20 })).toEqual({ reached: true });
  });

  it("is never reached against the unlimited sentinel", () => {
    expect(checkAgentMessageQuota({ used: 10_000, limit: UNLIMITED_AGENT_MESSAGES })).toEqual({
      reached: false,
    });
  });
});

describe("agentTurnCountsAgainstQuota", () => {
  it("counts a genuine new user message (submit-message)", () => {
    expect(
      agentTurnCountsAgainstQuota({ kind: "message", payload: { trigger: "submit-message" } })
    ).toBe(true);
  });

  it("does not count a retry/regenerate", () => {
    // Control break: a regenerate re-runs from history with no new message, so it must not
    // burn quota. Widen the rule back to `!== "action"` and this fails.
    expect(
      agentTurnCountsAgainstQuota({ kind: "message", payload: { trigger: "regenerate-message" } })
    ).toBe(false);
  });

  it("does not count a wake (action turn)", () => {
    expect(agentTurnCountsAgainstQuota({ kind: "message", payload: { trigger: "action" } })).toBe(
      false
    );
  });

  it("does not count a non-message turn or a missing body", () => {
    expect(agentTurnCountsAgainstQuota({ kind: "action" })).toBe(false);
    expect(agentTurnCountsAgainstQuota(undefined)).toBe(false);
  });
});

describe("currentAgentMessagePeriod", () => {
  it("is a zero-padded UTC calendar month", () => {
    expect(currentAgentMessagePeriod(new Date(Date.UTC(2026, 7, 9)))).toBe("2026-08");
    expect(currentAgentMessagePeriod(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
  });
});

describe("the per-(org, period) counter", () => {
  postgresTest(
    "accumulates and a deleted chat cannot free quota within the period",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());
      const period = "2026-08";

      // The create path and then an append: two messages, same period.
      expect(await incrementAgentMessageUsage(db, { organizationId: ORG, period })).toBe(1);
      expect(await incrementAgentMessageUsage(db, { organizationId: ORG, period })).toBe(2);
      expect(await getAgentMessageUsage(db, { organizationId: ORG, period })).toBe(2);

      // Deleting a chat must not move the counter: it is not joined to chats.
      await createChat(db, { id: "chat_del", organizationId: ORG, userId: USER });
      await softDeleteChat(db, { chatId: "chat_del", userId: USER, organizationId: ORG });
      expect(await getAgentMessageUsage(db, { organizationId: ORG, period })).toBe(2);

      // The next period and other orgs start fresh.
      expect(await getAgentMessageUsage(db, { organizationId: ORG, period: "2026-09" })).toBe(0);
      expect(await getAgentMessageUsage(db, { organizationId: "org_other", period })).toBe(0);
    }
  );
});

describe("resolveAgentMessageQuota", () => {
  postgresTest(
    "reports reached over the limit, and never reached when unlimited",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());
      const now = new Date();
      const period = currentAgentMessagePeriod(now);
      for (let i = 0; i < 3; i++) {
        await incrementAgentMessageUsage(db, { organizationId: ORG, period });
      }

      expect(
        await resolveAgentMessageQuota(db, { organizationId: ORG, now, readLimit: async () => 3 })
      ).toEqual({
        reached: true,
        used: 3,
        limit: 3,
      });
      expect(
        await resolveAgentMessageQuota(db, { organizationId: ORG, now, readLimit: async () => 20 })
      ).toEqual({ reached: false, used: 3, limit: 20 });

      // Self-hosted: the limit is absent, so the fallback (unlimited sentinel) applies and there
      // is no cap — no extra branching, it falls out of the fallback.
      const selfHosted = await resolveAgentMessageQuota(db, {
        organizationId: ORG,
        now,
        readLimit: async () => UNLIMITED_AGENT_MESSAGES,
      });
      expect(selfHosted?.reached).toBe(false);
    }
  );

  it("fails open when the counter read throws", async () => {
    const throwingDb = {
      select: () => {
        throw new Error("db down");
      },
    } as unknown as DashboardAgentDb;

    const result = await resolveAgentMessageQuota(throwingDb, {
      organizationId: ORG,
      readLimit: async () => 5,
    });
    expect(result).toBeUndefined();
  });
});
