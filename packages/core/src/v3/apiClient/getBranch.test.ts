import { afterEach, describe, expect, it, vi } from "vitest";
import { getBranch, getDevBranch } from "./getBranch.js";
import { DEFAULT_DEV_BRANCH } from "../utils/gitBranch.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getDevBranch", () => {
  it("prefers an explicitly specified branch over everything else", () => {
    vi.stubEnv("TRIGGER_DEV_BRANCH", "from-env");
    expect(getDevBranch({ specified: "from-flag" })).toBe("from-flag");
  });

  it("falls back to TRIGGER_DEV_BRANCH when nothing is specified", () => {
    vi.stubEnv("TRIGGER_DEV_BRANCH", "from-env");
    expect(getDevBranch({})).toBe("from-env");
  });

  it("falls back to the 'default' sentinel when neither flag nor env var is set", () => {
    vi.stubEnv("TRIGGER_DEV_BRANCH", "");
    expect(getDevBranch({})).toBe(DEFAULT_DEV_BRANCH);
    expect(getDevBranch({})).toBe("default");
  });

  // This is the load-bearing product decision (TRI-8726 Non-Goals): dev branch
  // selection is explicit/opt-in. Auto-detecting git HEAD would silently
  // fragment a user's dev setup every time they switch git branch. getBranch()
  // (deploy/preview) DOES use these signals; getDevBranch() must NOT.
  it("never auto-detects from git HEAD or Vercel env vars", () => {
    vi.stubEnv("TRIGGER_DEV_BRANCH", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature/from-vercel");
    vi.stubEnv("TRIGGER_PREVIEW_BRANCH", "feature/from-preview");

    expect(getDevBranch({})).toBe(DEFAULT_DEV_BRANCH);
  });

  it("returns a string in every case (never undefined, unlike getBranch)", () => {
    vi.stubEnv("TRIGGER_DEV_BRANCH", "");
    expect(typeof getDevBranch({})).toBe("string");
  });
});

describe("getBranch (preview/deploy) — guard against dev/preview divergence", () => {
  it("still falls back to Vercel/git signals, in contrast to getDevBranch", () => {
    vi.stubEnv("TRIGGER_PREVIEW_BRANCH", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature/from-vercel");
    expect(getBranch({})).toBe("feature/from-vercel");
  });

  it("returns undefined when no signal is available", () => {
    vi.stubEnv("TRIGGER_PREVIEW_BRANCH", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "");
    expect(getBranch({})).toBeUndefined();
  });
});
