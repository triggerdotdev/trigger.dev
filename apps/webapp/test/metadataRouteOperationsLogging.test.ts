import { describe, expect, it, vi } from "vitest";

// `vi.mock` factories are hoisted above regular top-level `const`s, so
// any cross-references between the spy/mock fns and the factories have
// to live inside `vi.hoisted`. See `mollifierDrainerHandler.test.ts`
// for the same pattern.
const { warnSpy, applyMetadataMutationToBufferedRunMock } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  applyMetadataMutationToBufferedRunMock: vi.fn(),
}));

// The route module's import graph (createActionApiRoute, the env, the
// services singleton) is heavier than the helper actually needs. Stub
// the leaf modules so only the helper under test executes; the route's
// top-level `createActionApiRoute(...)` call runs against the stubbed
// builder and never touches platform.v3.server / prisma.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({
  env: { TASK_RUN_METADATA_MAXIMUM_SIZE: 256 * 1024 },
}));
vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  createActionApiRoute: () => ({ action: vi.fn() }),
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateApiRequest: vi.fn(),
}));
vi.mock("~/v3/services/common.server", () => ({
  ServiceValidationError: class extends Error {
    constructor(public override message: string, public status?: number) {
      super(message);
    }
  },
}));
vi.mock("~/services/metadata/updateMetadataInstance.server", () => ({
  updateMetadataService: { call: vi.fn(async () => undefined) },
}));
vi.mock("~/v3/mollifier/applyMetadataMutation.server", () => ({
  applyMetadataMutationToBufferedRun: applyMetadataMutationToBufferedRunMock,
}));
vi.mock("~/v3/mollifier/readFallback.server", () => ({
  findRunByIdWithMollifierFallback: vi.fn(),
}));
vi.mock("~/services/logger.server", () => ({
  logger: {
    warn: warnSpy,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { routeOperationsToRun } from "~/routes/api.v1.runs.$runId.metadata";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

const env = {
  id: "env_a",
  organizationId: "org_1",
} as unknown as AuthenticatedEnvironment;

const opsFixture = [{ type: "set", key: "k", value: "v" }] as Parameters<
  typeof routeOperationsToRun
>[1];

describe("routeOperationsToRun — non-throw buffer outcome logging", () => {
  // Each non-success outcome `applyMetadataMutationToBufferedRun` can
  // return (`not_found`, `busy`, `version_exhausted`, `metadata_too_large`)
  // must produce a warn log so ops can trace silent drops. Without this
  // branch the parent/root operation would disappear with no record —
  // `tryCatch` only catches throws, and the outcome object was
  // previously ignored.
  for (const kind of ["not_found", "busy", "version_exhausted", "metadata_too_large"] as const) {
    it(`warn-logs when buffer outcome is { kind: "${kind}" }`, async () => {
      warnSpy.mockClear();
      applyMetadataMutationToBufferedRunMock.mockResolvedValueOnce({ kind });

      await routeOperationsToRun("run_buffered_1", opsFixture, env);

      expect(warnSpy).toHaveBeenCalledWith(
        "metadata route: parent/root buffer op did not apply",
        expect.objectContaining({ targetRunId: "run_buffered_1", kind }),
      );
    });
  }

  it("does NOT warn on the happy path (kind: 'applied')", async () => {
    warnSpy.mockClear();
    applyMetadataMutationToBufferedRunMock.mockResolvedValueOnce({
      kind: "applied",
      newMetadata: { k: "v" },
      parentTaskRunFriendlyId: undefined,
      rootTaskRunFriendlyId: undefined,
    });

    await routeOperationsToRun("run_buffered_1", opsFixture, env);

    expect(warnSpy).not.toHaveBeenCalledWith(
      "metadata route: parent/root buffer op did not apply",
      expect.anything(),
    );
  });

  it("warn-logs once when the helper throws (the pre-existing throw branch keeps working)", async () => {
    warnSpy.mockClear();
    applyMetadataMutationToBufferedRunMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    await routeOperationsToRun("run_buffered_1", opsFixture, env);

    // Pre-existing branch — the catch logs `buffer fallback for parent/root
    // op failed`. The new non-throw branch must NOT also fire (we return
    // early on bufferError).
    expect(warnSpy).toHaveBeenCalledWith(
      "metadata route: buffer fallback for parent/root op failed",
      expect.objectContaining({ targetRunId: "run_buffered_1" }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      "metadata route: parent/root buffer op did not apply",
      expect.anything(),
    );
  });

  it("skips both PG and buffer when targetRunId is missing or operations is empty", async () => {
    warnSpy.mockClear();
    applyMetadataMutationToBufferedRunMock.mockClear();

    await routeOperationsToRun(undefined, opsFixture, env);
    await routeOperationsToRun("run_x", undefined, env);
    await routeOperationsToRun("run_x", [], env);

    expect(applyMetadataMutationToBufferedRunMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
