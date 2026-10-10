import { describe, expect, it, vi } from "vitest";
import { enqueueGithubBuildWithClient } from "./enqueueGithubBuild.server";

const sha = "a".repeat(40);

function run(fetch: ReturnType<typeof vi.fn>, onFailure = vi.fn()) {
  return enqueueGithubBuildWithClient(
    { fetch } as never,
    "proj_1",
    "deployment_1",
    { commitSha: sha, ref: "main" },
    { configFilePath: "trigger.config.ts" },
    onFailure
  ).then((result) => ({ result, onFailure }));
}

describe("enqueueGithubBuildWithClient", () => {
  it("posts the github source and returns the build id", async () => {
    const fetch = vi.fn().mockResolvedValue({ success: true, buildId: "build_1" });
    const { result, onFailure } = await run(fetch);
    expect(result._unsafeUnwrap()).toEqual({ buildId: "build_1" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/projects/proj_1/enqueue-build",
      expect.anything(),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          deploymentId: "deployment_1",
          github: { commitSha: sha, ref: "main" },
          options: { configFilePath: "trigger.config.ts" },
        }),
      })
    );
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps the platform's own error text and code on an unsuccessful response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ success: false, code: "COMMIT_NOT_FOUND", error: "Commit not found" });
    const { result, onFailure } = await run(fetch);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "build_rejected",
      code: "COMMIT_NOT_FOUND",
      error: "Commit not found",
    });
    expect(onFailure).toHaveBeenCalledWith("no_success");
  });

  it("hides transport details when the request throws", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed: billing.internal:443"));
    const { result, onFailure } = await run(fetch);
    expect(result._unsafeUnwrapErr()).toEqual({ type: "build_service_unreachable" });
    expect(onFailure).toHaveBeenCalledWith("caught");
  });
});
