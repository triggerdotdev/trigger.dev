import {
  createChat,
  createDashboardAgentDb,
  getInvestigation,
  settleInvestigationAndCloseCard,
  upsertInvestigationRevision,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import {
  investigationStateSchema,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  agentDb: undefined as unknown as DashboardAgentDb,
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

const { sweepDashboardAgentInvestigations, INVESTIGATION_STALE_MS, MAX_SWEEP_ATTEMPTS } =
  await import("~/services/dashboardAgentInvestigationSweep.server");

async function applyAgentSchema(prisma: PrismaClient) {
  const folder = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");
  const migrations = readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    const sql = readFileSync(path.join(folder, name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await prisma.$executeRawUnsafe(trimmed);
    }
  }
}

let agentDbClient: DashboardAgentDbClient | undefined;
let prismaForRaw: PrismaClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  ctx.agentDb = agentDbClient.db;
  prismaForRaw = prisma;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

const ORG = "org_poison";
const USER = "user_poison";

function openState(): InvestigationState {
  return investigationStateSchema.parse({
    outcome: "in_progress",
    severity: "warn",
    confidence: "medium",
    title: "a stuck card",
    headline: "Still checking.",
    progress: "Reading spans",
    checkNext: [],
    hypotheses: [],
    evidence: [],
  });
}

async function seedInvestigation(chatId: string, ageMs: number): Promise<string> {
  await createChat(ctx.agentDb, { id: chatId, organizationId: ORG, userId: USER });
  const created = await upsertInvestigationRevision(ctx.agentDb, {
    chatId,
    projectRef: "proj",
    environmentRef: "env",
    state: openState(),
  });
  if (!created.ok) throw new Error("fixture investigation not created");
  await prismaForRaw!.$executeRawUnsafe(
    `update trigger_dashboard_agent.investigations
     set updated_at = now() - ($2 || ' milliseconds')::interval where id = $1`,
    created.id,
    String(ageMs)
  );
  return created.id;
}

async function outcomeOf(id: string): Promise<string | undefined> {
  const row = await getInvestigation(ctx.agentDb, { id });
  return row ? (row.state as { outcome?: string }).outcome : undefined;
}

const STALE_AGE_MS = INVESTIGATION_STALE_MS + 60_000;
const OLDER_AGE_MS = STALE_AGE_MS + 60_000;

describe("the investigation sweep with a poison row", () => {
  postgresTest(
    "a row that always fails to settle cannot pin the head and starve a newer row",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      // Poison sorts first (older `updated_at`); renderable is newer.
      const poisonId = await seedInvestigation("chat_poison", OLDER_AGE_MS);
      const renderableId = await seedInvestigation("chat_ok", STALE_AGE_MS);

      // Only the poison row's settle throws; the renderable one goes through the real path.
      const settleAndClose = (params: { id: string; chatId: string; note: string }) => {
        if (params.id === poisonId) throw new Error("state isn't renderable");
        return settleInvestigationAndCloseCard(ctx.agentDb, params);
      };

      // limit 1 forces head contention: without backoff the poison row would win every run.
      // A failed run throws so the job retries, but the attempt is recorded before it does.
      await expect(
        sweepDashboardAgentInvestigations({ limit: 1, settleAndClose })
      ).rejects.toThrow();
      expect(await outcomeOf(poisonId)).toBe("in_progress");
      expect(await outcomeOf(renderableId)).toBe("in_progress");

      // Next run: the poison row now sorts behind the never-attempted renderable one,
      // so the newer row is picked and settled despite the poison row still being stale.
      const second = await sweepDashboardAgentInvestigations({ limit: 1, settleAndClose });
      expect(second).toMatchObject({ stale: 1, settled: 1, failed: 0 });
      expect(await outcomeOf(renderableId)).toBe("inconclusive");
      expect(await outcomeOf(poisonId)).toBe("in_progress");
    },
    30_000
  );

  postgresTest(
    "after the attempt cap the poison row is abandoned and leaves the queue",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const poisonId = await seedInvestigation("chat_poison", STALE_AGE_MS);

      const settleAndClose = () => {
        throw new Error("state isn't renderable");
      };

      // The first MAX_SWEEP_ATTEMPTS-1 runs record a failed attempt and throw; the row stays stale.
      for (let i = 1; i < MAX_SWEEP_ATTEMPTS; i++) {
        await expect(sweepDashboardAgentInvestigations({ settleAndClose })).rejects.toThrow();
        expect(await outcomeOf(poisonId)).toBe("in_progress");
      }

      // The capped run force-settles the row without the render path, so it leaves the queue.
      const capped = await sweepDashboardAgentInvestigations({ settleAndClose });
      expect(capped).toMatchObject({ stale: 1, abandoned: 1, failed: 0 });
      expect(await outcomeOf(poisonId)).toBe("inconclusive");

      // Nothing stale remains, so the poison row is no longer swept.
      const after = await sweepDashboardAgentInvestigations({ settleAndClose });
      expect(after).toMatchObject({ stale: 0 });
    },
    30_000
  );
});
