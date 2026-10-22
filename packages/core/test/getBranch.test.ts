import { afterEach, describe, expect, it, vi } from "vitest";
import { getBranch } from "../src/v3/apiClient/getBranch.js";

describe("getBranch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the git branch when nothing else is set", () => {
    vi.stubEnv("TRIGGER_PREVIEW_BRANCH", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "");

    expect(getBranch({ gitMeta: { commitRef: "feature/login" } })).toBe("feature/login");
  });

  it("doesn't treat a detached HEAD as a branch", () => {
    vi.stubEnv("TRIGGER_PREVIEW_BRANCH", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "");

    expect(getBranch({ gitMeta: { commitRef: "HEAD" } })).toBeUndefined();
    expect(getBranch({ specified: "feature/login", gitMeta: { commitRef: "HEAD" } })).toBe(
      "feature/login"
    );
  });
});
