import { buildJwtAbility } from "@trigger.dev/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  handlers: [] as Array<{ config: any; handler: any }>,
  creates: [] as Array<Record<string, unknown>>,
}));

vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  createActionApiRoute: (config: any, handler: any) => {
    H.handlers.push({ config, handler });
    return { action: vi.fn() };
  },
  createLoaderApiRoute: () => ({ loader: vi.fn() }),
}));

vi.mock("~/env.server", () => ({ env: { BULK_ACTION_MAX_RUN_IDS: 100 } }));

vi.mock("~/services/logger.server", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("~/presenters/v3/ApiBulkActionPresenter.server", () => ({
  ApiBulkActionListSearchParams: {},
  ApiBulkActionPresenter: class {},
}));

vi.mock("~/presenters/v3/ApiRunListPresenter.server", () => ({
  ApiRunListPresenter: { apiStatusToRunStatuses: () => [] },
}));

vi.mock("~/v3/services/bulk/BulkActionV2.server", () => ({
  BulkActionService: class {
    async create(args: Record<string, unknown>) {
      H.creates.push(args);
      return { bulkActionId: "bulk_test" };
    }
  },
}));

async function createHandler() {
  await import("~/routes/api.v1.bulk-actions");
  const entry = H.handlers[0];
  if (!entry) throw new Error("bulk actions create handler was not captured");
  return entry.handler as (args: any) => Promise<Response>;
}

const authentication = {
  environment: { id: "env_1", projectId: "proj_1", organizationId: "org_1" },
};

const taskScoped = ["trigger:tasks:report", "batchTrigger:tasks:report", "read:runs", "write:runs"];

beforeEach(() => {
  H.creates = [];
});

describe("bulk actions create authorization", () => {
  it("refuses bulk replay for a key limited to selected tasks", async () => {
    const handler = await createHandler();
    const response = await handler({
      ability: buildJwtAbility(taskScoped),
      authentication,
      body: { action: "replay", runIds: ["run_hello"] },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        "Bulk replay needs a key that can trigger all tasks. Keys limited to selected tasks can replay runs one at a time.",
    });
    expect(H.creates).toHaveLength(0);
  });

  it("refuses bulk replay by filter for a key limited to selected tasks", async () => {
    const handler = await createHandler();
    const response = await handler({
      ability: buildJwtAbility(taskScoped),
      authentication,
      body: { action: "replay", filter: { taskIdentifier: "report" } },
    });

    expect(response.status).toBe(403);
    expect(H.creates).toHaveLength(0);
  });

  it("refuses bulk replay for a key without trigger", async () => {
    const handler = await createHandler();
    const response = await handler({
      ability: buildJwtAbility(["read:runs", "write:runs"]),
      authentication,
      body: { action: "replay", runIds: ["run_hello"] },
    });

    expect(response.status).toBe(403);
    expect(H.creates).toHaveLength(0);
  });

  it("allows bulk cancel for a key limited to selected tasks", async () => {
    const handler = await createHandler();
    const response = await handler({
      ability: buildJwtAbility(taskScoped),
      authentication,
      body: { action: "cancel", runIds: ["run_hello"] },
    });

    expect(response.status).toBe(202);
    expect(H.creates).toHaveLength(1);
  });

  it("allows bulk replay for a key that can trigger all tasks", async () => {
    const handler = await createHandler();
    const response = await handler({
      ability: buildJwtAbility(["trigger:tasks", "read:runs", "write:runs"]),
      authentication,
      body: { action: "replay", runIds: ["run_hello"] },
    });

    expect(response.status).toBe(202);
    expect(H.creates).toHaveLength(1);
  });
});
