import { createDashboardAgentDb, type DashboardAgentDbClient } from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { runTranscriptStorageTests } from "@trigger.dev/sdk/ai/test";
import type { TranscriptStorageContext } from "@trigger.dev/sdk/ai";
import type { UIMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboardAgentTranscriptStorage } from "./transcript-storage";

type StartedContainer = { getConnectionUri(): string; stop(): Promise<unknown> };

let container: StartedContainer | undefined;
let client: DashboardAgentDbClient | undefined;

beforeAll(async () => {
  const started = (await createStandalonePostgresContainer()) as {
    url?: string;
    container: StartedContainer;
  };
  container = started.container;
  client = createDashboardAgentDb(started.url ?? started.container.getConnectionUri(), { max: 2 });
  await applyDashboardAgentMigrations((statement) => client!.sql.unsafe(statement));
});

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

describe("dashboardAgentTranscriptStorage", () => {
  runTranscriptStorageTests(() => dashboardAgentTranscriptStorage(client!.db), {
    api: { describe, it, expect },
    chatId: "dashboard-agent-conformance",
    clientData: { organizationId: "org_conformance", userId: "user_conformance" },
  });
});

type Scope = { organizationId: string; userId: string };

const OWNER: Scope = { organizationId: "org_owner", userId: "user_owner" };

function ctx(chatId: string, clientData: Scope): TranscriptStorageContext<Scope> {
  return {
    chatId,
    clientData,
    turn: 0,
    trigger: "submit-message",
    runId: "run_test",
    ctx: {} as TranscriptStorageContext["ctx"],
  };
}

function text(id: string, text: string, role: "user" | "assistant" = "assistant"): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

async function put(chatId: string, clientData: Scope, ...messages: UIMessage[]) {
  await dashboardAgentTranscriptStorage(client!.db).save(ctx(chatId, clientData), {
    reason: "turn-complete",
    changes: messages.map((message) => ({ op: "put", message })),
    transcript: {
      entries: messages.map((message) => ({ id: message.id, final: true, message })),
      state: null,
    },
  });
}

describe("dashboardAgentTranscriptStorage tenancy", () => {
  // The chat id comes from the session and the tenancy from its `clientData`. If they
  // ever disagree, nothing may land in another org or user's transcript, and nothing
  // may be read out of it.
  it("refuses to save into a chat another tenant owns, and reads nothing from it", async () => {
    const chatId = "dashboard-agent-tenancy";
    await put(chatId, OWNER, text("u1", "mine", "user"));

    const intruder: Scope = { organizationId: "org_other", userId: "user_other" };
    await expect(put(chatId, intruder, text("a1", "not yours"))).rejects.toThrow(/does not belong/);

    const storage = dashboardAgentTranscriptStorage(client!.db);
    const owned = await storage.load({ chatId, clientData: OWNER });
    expect(owned.messages.map((m) => m.id)).toEqual(["u1"]);
    const foreign = await storage.load({ chatId, clientData: intruder });
    expect(foreign.messages).toEqual([]);
  });
});

describe("dashboardAgentTranscriptStorage message bodies", () => {
  // A model can emit a lone surrogate, which jsonb rejects. One bad character must not
  // lose the turn: the adapter normalises before the write, the way the old hook path did.
  it("stores a message with a lone surrogate in it", async () => {
    const chatId = "dashboard-agent-surrogate";
    await put(chatId, OWNER, text("u1", "hi", "user"), text("a1", "broken \ud83d here"));

    const loaded = await dashboardAgentTranscriptStorage(client!.db).load({
      chatId,
      clientData: OWNER,
    });
    expect(loaded.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    const stored = loaded.messages[1]!.parts[0] as { text: string };
    expect(stored.text.includes("\ud83d")).toBe(false);
    expect(stored.text).toContain("broken");
  });
});
