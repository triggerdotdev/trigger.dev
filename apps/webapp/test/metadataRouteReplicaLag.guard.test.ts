import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    replica: {},
    environment: { id: "env_meta", organizationId: "org_meta" },
    authenticateApiRequest: vi.fn(),
    findRun: vi.fn(),
    findRunOnPrimary: vi.fn(),
    findRunByIdWithMollifierFallback: vi.fn(),
  },
}));

vi.mock("~/db.server", () => ({ prisma: {}, $replica: mocks.replica }));
vi.mock("~/env.server", () => ({
  env: {
    TASK_RUN_METADATA_MAXIMUM_SIZE: 256 * 1024,
    TRIGGER_MOLLIFIER_METADATA_MAX_RETRIES: 3,
    TRIGGER_MOLLIFIER_METADATA_BACKOFF_BASE_MS: 10,
    TRIGGER_MOLLIFIER_METADATA_BACKOFF_STEP_MS: 10,
  },
}));
vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  createActionApiRoute: () => ({ action: vi.fn() }),
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateApiRequest: mocks.authenticateApiRequest,
}));
vi.mock("~/v3/runStore.server", () => ({
  runStore: {
    findRun: mocks.findRun,
    findRunOnPrimary: mocks.findRunOnPrimary,
  },
}));
vi.mock("~/v3/mollifier/readFallback.server", () => ({
  findRunByIdWithMollifierFallback: mocks.findRunByIdWithMollifierFallback,
}));
vi.mock("~/v3/mollifier/applyMetadataMutation.server", () => ({
  applyMetadataMutationToBufferedRun: vi.fn(),
}));
vi.mock("~/services/metadata/updateMetadataInstance.server", () => ({
  updateMetadataService: { call: vi.fn(async () => undefined) },
}));
vi.mock("~/services/realtime/runChangeNotifierInstance.server", () => ({
  publishChangeRecord: vi.fn(),
}));
vi.mock("~/v3/services/common.server", () => ({
  ServiceValidationError: class extends Error {},
}));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loader } from "~/routes/api.v1.runs.$runId.metadata";

const friendlyId = "run_meta_live";
const runWhere = { friendlyId, runtimeEnvironmentId: mocks.environment.id };
const metadataSelect = { select: { metadata: true, metadataType: true } };

async function callLoader(runId = friendlyId) {
  return (await loader({
    request: new Request(`https://example.com/api/v1/runs/${runId}/metadata`, {
      headers: { Authorization: "Bearer tr_dev_meta" },
    }),
    params: { runId },
    context: {} as never,
  })) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateApiRequest.mockResolvedValue({ environment: mocks.environment });
  mocks.findRun.mockResolvedValue(null);
  mocks.findRunByIdWithMollifierFallback.mockResolvedValue(null);
  mocks.findRunOnPrimary.mockResolvedValue(null);
});

describe("metadata GET loader under replica lag", () => {
  it("resolves a live run after a replica and buffer double-miss", async () => {
    const metadata = '{"phase":"one"}';
    mocks.findRunOnPrimary.mockResolvedValue({
      metadata,
      metadataType: "application/json",
    });

    const response = await callLoader();

    expect(mocks.findRun).toHaveBeenCalledWith(runWhere, metadataSelect, mocks.replica);
    expect(mocks.findRunByIdWithMollifierFallback).toHaveBeenCalledWith({
      runId: friendlyId,
      environmentId: mocks.environment.id,
      organizationId: mocks.environment.organizationId,
    });
    expect(mocks.findRunOnPrimary).toHaveBeenCalledWith(runWhere, metadataSelect);
    expect(mocks.findRun.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findRunByIdWithMollifierFallback.mock.invocationCallOrder[0]
    );
    expect(mocks.findRunByIdWithMollifierFallback.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findRunOnPrimary.mock.invocationCallOrder[0]
    );
    await expect(response.json()).resolves.toEqual({
      metadata,
      metadataType: "application/json",
    });
    expect(response.status).toBe(200);
  });

  it("returns 404 when the run is absent from the primary too", async () => {
    const response = await callLoader("run_does_not_exist");

    expect(mocks.findRunOnPrimary).toHaveBeenCalledWith(
      { friendlyId: "run_does_not_exist", runtimeEnvironmentId: mocks.environment.id },
      metadataSelect
    );
    await expect(response.json()).resolves.toEqual({ error: "Run not found" });
    expect(response.status).toBe(404);
  });
});
