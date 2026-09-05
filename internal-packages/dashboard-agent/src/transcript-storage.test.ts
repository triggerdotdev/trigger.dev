import { createDashboardAgentDb, type DashboardAgentDbClient } from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { runTranscriptStorageTests } from "@trigger.dev/sdk/ai/test";
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
