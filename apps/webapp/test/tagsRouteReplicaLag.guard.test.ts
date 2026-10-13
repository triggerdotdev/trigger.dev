import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the delete-then-add sequence. `tags.add()` dedups the
// requested tags against the run row handed to it by `mutateWithFallback`, and that
// row normally comes from the READ REPLICA. Before `tags.delete()` existed a stale
// replica could only ever make an add bigger than necessary, so the dedup was safe.
// Now a replica can still be carrying a tag the primary has already dropped, and
// deduping against it would silently swallow the add. The add path therefore
// confirms an apparent duplicate against the primary before skipping the write.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    writer: { __client: "writer" },
    replica: { __client: "replica" },
    environment: { id: "env_tags", organizationId: "org_tags" },
    authenticateApiRequest: vi.fn(),
    findRun: vi.fn(),
    pushTags: vi.fn(),
    removeTags: vi.fn(),
    publishChangeRecord: vi.fn(),
    mutateWithFallback: vi.fn(),
  },
}));

vi.mock("~/db.server", () => ({ prisma: mocks.writer, $replica: mocks.replica }));
vi.mock("~/models/taskRunTag.server", () => ({ MAX_TAGS_PER_RUN: 10 }));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateApiRequest: mocks.authenticateApiRequest,
}));
vi.mock("~/services/httpAsyncStorage.server", () => ({
  getRequestAbortSignal: () => undefined,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/services/realtime/runChangeNotifierInstance.server", () => ({
  publishChangeRecord: mocks.publishChangeRecord,
}));
vi.mock("~/v3/mollifier/mutateWithFallback.server", () => ({
  mutateWithFallback: mocks.mutateWithFallback,
}));
vi.mock("~/v3/runStore.server", () => ({
  runStore: {
    findRun: mocks.findRun,
    pushTags: mocks.pushTags,
    removeTags: mocks.removeTags,
  },
}));

import { action } from "~/routes/api.v1.runs.$runId.tags";

const runId = "run_tags_lag";

// Drive the route straight down the PG path with a caller-supplied row, standing in
// for what `mutateWithFallback` reads off the replica.
function replicaRowIs(runTags: string[]) {
  mocks.mutateWithFallback.mockImplementation(async (input: any) => ({
    kind: "pg",
    response: await input.pgMutation({ id: runId, runTags, batchId: null }),
  }));
}

async function callAction(method: "POST" | "DELETE", tags: string | string[]) {
  return (await action({
    request: new Request(`https://example.com/api/v1/runs/${runId}/tags`, {
      method,
      headers: { Authorization: "Bearer tr_dev_tags", "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    }),
    params: { runId },
    context: {} as never,
  })) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateApiRequest.mockResolvedValue({ environment: mocks.environment });
  mocks.pushTags.mockResolvedValue({ updatedAt: new Date("2026-08-29T12:00:00Z") });
  mocks.removeTags.mockResolvedValue({ updatedAt: new Date("2026-08-29T12:00:00Z") });
  mocks.findRun.mockResolvedValue(null);
});

describe("tags POST under replica lag after a delete", () => {
  it("re-adds a tag the replica still shows but the primary has already dropped", async () => {
    // The awaited DELETE removed "status_processing" on the primary; the replica
    // hasn't caught up and still lists it.
    replicaRowIs(["status_processing"]);
    mocks.findRun.mockResolvedValue({ runTags: [] });

    const response = await callAction("POST", "status_processing");

    // The apparent duplicate was confirmed against the OWNING store's primary by
    // passing the writer as the read client.
    expect(mocks.findRun).toHaveBeenCalledWith(
      { id: runId, runtimeEnvironmentId: mocks.environment.id },
      { select: { runTags: true } },
      mocks.writer
    );
    // ...and the write actually happened rather than being deduped away.
    expect(mocks.pushTags).toHaveBeenCalledWith(
      runId,
      ["status_processing"],
      { runtimeEnvironmentId: mocks.environment.id },
      mocks.writer
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: "Successfully set 1 new tags.",
    });
  });

  it("still skips the write when the primary agrees the tag is present", async () => {
    replicaRowIs(["status_processing"]);
    mocks.findRun.mockResolvedValue({ runTags: ["status_processing"] });

    const response = await callAction("POST", "status_processing");

    expect(mocks.findRun).toHaveBeenCalledTimes(1);
    expect(mocks.pushTags).not.toHaveBeenCalled();
    expect(mocks.publishChangeRecord).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: "No new tags to add" });
  });

  it("recovers the deleted tag when only part of the request looks duplicated", async () => {
    replicaRowIs(["a"]);
    mocks.findRun.mockResolvedValue({ runTags: [] });

    const response = await callAction("POST", ["a", "b"]);

    expect(mocks.pushTags).toHaveBeenCalledWith(
      runId,
      ["a", "b"],
      { runtimeEnvironmentId: mocks.environment.id },
      mocks.writer
    );
    await expect(response.json()).resolves.toEqual({
      message: "Successfully set 2 new tags.",
    });
  });

  it("publishes the change record with the confirmed tag set", async () => {
    replicaRowIs(["a"]);
    mocks.findRun.mockResolvedValue({ runTags: ["b"] });

    await callAction("POST", ["a"]);

    expect(mocks.publishChangeRecord).toHaveBeenCalledWith(
      expect.objectContaining({ runId, envId: mocks.environment.id, tags: ["b", "a"] })
    );
  });

  it("does not touch the primary when no requested tag looks duplicated", async () => {
    replicaRowIs(["something_else"]);

    const response = await callAction("POST", "brand_new");

    expect(mocks.findRun).not.toHaveBeenCalled();
    expect(mocks.pushTags).toHaveBeenCalledWith(
      runId,
      ["brand_new"],
      { runtimeEnvironmentId: mocks.environment.id },
      mocks.writer
    );
    expect(response.status).toBe(200);
  });

  it("404s when the confirmation read finds the run gone", async () => {
    replicaRowIs(["status_processing"]);
    mocks.findRun.mockResolvedValue(null);

    const response = await callAction("POST", "status_processing");

    expect(mocks.pushTags).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Run not found" });
  });
});

describe("tags DELETE keeps its own primary confirmation", () => {
  it("removes a tag the replica has not caught up on yet", async () => {
    // The replica predates the add, so it shows none of the requested tags.
    replicaRowIs([]);
    mocks.findRun.mockResolvedValue({ runTags: ["status_processing"] });

    const response = await callAction("DELETE", "status_processing");

    expect(mocks.removeTags).toHaveBeenCalledWith(
      runId,
      ["status_processing"],
      { runtimeEnvironmentId: mocks.environment.id },
      mocks.writer
    );
    await expect(response.json()).resolves.toEqual({
      message: "Successfully removed 1 tags.",
    });
  });

  it("reports a genuine no-op without writing", async () => {
    replicaRowIs([]);
    mocks.findRun.mockResolvedValue({ runTags: [] });

    const response = await callAction("DELETE", "never_had_it");

    expect(mocks.removeTags).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: "Successfully removed 0 tags.",
    });
  });
});
