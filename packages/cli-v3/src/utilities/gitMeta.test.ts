import { describe, expect, it } from "vitest";
import { getCiBranch, sanitizeGitRemoteUrl } from "./gitMeta.js";

describe("sanitizeGitRemoteUrl", () => {
  it.each([
    ["https://token@example.com/org/repo.git", "https://example.com/org/repo.git"],
    ["https://user:password@example.com/org/repo.git", "https://example.com/org/repo.git"],
    ["ssh://git@example.com/org/repo.git", "ssh://example.com/org/repo.git"],
    ["https:/user:secret@example.com/org/repo.git", "https://example.com/org/repo.git"],
    ["https:user:secret@example.com/org/repo.git", "https://example.com/org/repo.git"],
    ["https:\\user:secret@example.com\\org\\repo.git", "https://example.com/org/repo.git"],
    [" https:/user:secret@example.com/org/repo.git ", "https://example.com/org/repo.git"],
  ])("strips userinfo from URL and scheme-looking remotes", (remote, expected) => {
    expect(sanitizeGitRemoteUrl(remote)).toBe(expected);
  });

  it.each([
    "git@example.com:org/repo.git",
    "example.com:org/repo.git",
    "/workspace/repo",
    "../repo",
    "./repo",
    "repo",
    "C:\\workspace\\repo",
    "file:///workspace/repo.git",
  ])("preserves scp-style and local remotes", (remote) => {
    expect(sanitizeGitRemoteUrl(remote)).toBe(remote);
  });

  it.each([
    "https://user:secret@ invalid/repo.git",
    "https:/user:secret@ invalid/repo.git",
    " https:/user:secret@ invalid/repo.git ",
  ])("omits malformed URL-style remotes", (remote) => {
    expect(sanitizeGitRemoteUrl(remote)).toBeUndefined();
  });
});

describe("getCiBranch", () => {
  it("returns undefined outside CI", () => {
    expect(getCiBranch({})).toBeUndefined();
  });

  it("reads GitLab branch and merge request pipelines", () => {
    expect(getCiBranch({ GITLAB_CI: "true", CI_COMMIT_BRANCH: "feature/login" })).toBe(
      "feature/login"
    );
    expect(
      getCiBranch({
        GITLAB_CI: "true",
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/login",
        CI_COMMIT_BRANCH: "main",
      })
    ).toBe("feature/login");
  });

  it("prefers the pull request branch over the target branch on Travis", () => {
    expect(
      getCiBranch({ TRAVIS: "true", TRAVIS_PULL_REQUEST_BRANCH: "", TRAVIS_BRANCH: "main" })
    ).toBe("main");
    expect(
      getCiBranch({ TRAVIS: "true", TRAVIS_PULL_REQUEST_BRANCH: "fix", TRAVIS_BRANCH: "main" })
    ).toBe("fix");
  });

  it("strips branch refs and skips other refs on Azure Pipelines", () => {
    expect(getCiBranch({ TF_BUILD: "True", BUILD_SOURCEBRANCH: "refs/heads/feature/login" })).toBe(
      "feature/login"
    );
    expect(
      getCiBranch({ TF_BUILD: "True", BUILD_SOURCEBRANCH: "refs/tags/v1.0.0" })
    ).toBeUndefined();
    expect(
      getCiBranch({
        TF_BUILD: "True",
        SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature/login",
        BUILD_SOURCEBRANCH: "refs/pull/12/merge",
      })
    ).toBe("feature/login");
  });

  it("only reads the detected provider's variables", () => {
    expect(getCiBranch({ BRANCH_NAME: "not-jenkins" })).toBeUndefined();
    expect(getCiBranch({ GITLAB_CI: "true", BRANCH_NAME: "not-jenkins" })).toBeUndefined();
    expect(
      getCiBranch({ JENKINS_URL: "https://ci.example.com", BRANCH_NAME: "feature/login" })
    ).toBe("feature/login");
  });
});
