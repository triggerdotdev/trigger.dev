import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitMeta, getCiBranch, getGitTopLevel, sanitizeGitRemoteUrl } from "./gitMeta.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

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

describe("git worktree support", () => {
  async function createRepoWithWorktrees() {
    const baseDir = await mkdtemp(join(tmpdir(), "trigger-git-worktree-"));
    tempDirs.push(baseDir);

    const repoDir = join(baseDir, "repo");
    await mkdir(repoDir, { recursive: true });

    runGit(repoDir, ["init", "-b", "main"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, [
      "remote",
      "add",
      "origin",
      "https://token@example.com/triggerdotdev/trigger.dev.git",
    ]);

    await writeFile(join(repoDir, ".gitignore"), ".worktrees/\n");
    await writeFile(join(repoDir, "index.ts"), "export const version = 1;\n");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "initial main commit"]);
    const mainSha = runGit(repoDir, ["rev-parse", "HEAD"]);

    const externalWorktreeDir = join(baseDir, "worktree-external");
    runGit(repoDir, ["worktree", "add", "-b", "release/external", externalWorktreeDir]);
    await writeFile(join(externalWorktreeDir, "index.ts"), "export const version = 2;\n");
    runGit(externalWorktreeDir, ["add", "index.ts"]);
    runGit(externalWorktreeDir, ["commit", "-m", "external worktree commit"]);
    const externalSha = runGit(externalWorktreeDir, ["rev-parse", "HEAD"]);

    const nestedWorktreeDir = join(repoDir, ".worktrees", "release");
    runGit(repoDir, ["worktree", "add", "-b", "release/nested", nestedWorktreeDir]);
    await writeFile(join(nestedWorktreeDir, "index.ts"), "export const version = 3;\n");
    runGit(nestedWorktreeDir, ["add", "index.ts"]);
    runGit(nestedWorktreeDir, ["commit", "-m", "nested worktree commit"]);
    const nestedSha = runGit(nestedWorktreeDir, ["rev-parse", "HEAD"]);

    // Make the outer checkout dirty to verify nested worktrees do not inherit its status
    await writeFile(join(repoDir, "index.ts"), "export const version = 99;\n");

    return {
      repoDir,
      mainSha,
      externalWorktreeDir,
      externalSha,
      nestedWorktreeDir,
      nestedSha,
    };
  }

  it("reads sanitized origin remoteUrl and commit metadata from an external linked worktree", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("TRIGGER_GITHUB_APP", "");

    const { externalWorktreeDir, externalSha } = await createRepoWithWorktrees();

    await expect(getGitTopLevel(externalWorktreeDir)).resolves.toBe(externalWorktreeDir);
    await expect(createGitMeta(externalWorktreeDir)).resolves.toEqual({
      source: "local",
      remoteUrl: "https://example.com/triggerdotdev/trigger.dev.git",
      commitAuthorName: "Test User",
      commitMessage: "external worktree commit",
      commitRef: "release/external",
      commitSha: externalSha,
      dirty: false,
    });
  });

  it("resolves nested worktree root and metadata instead of the outer checkout", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("TRIGGER_GITHUB_APP", "");

    const { repoDir, mainSha, nestedWorktreeDir, nestedSha } = await createRepoWithWorktrees();
    const nestedSubdir = join(nestedWorktreeDir, "packages", "app");
    await mkdir(nestedSubdir, { recursive: true });

    await expect(getGitTopLevel(nestedWorktreeDir)).resolves.toBe(nestedWorktreeDir);
    await expect(getGitTopLevel(nestedSubdir)).resolves.toBe(nestedWorktreeDir);

    const outerMeta = await createGitMeta(repoDir);
    expect(outerMeta).toMatchObject({
      commitRef: "main",
      commitSha: mainSha,
      dirty: true,
    });

    const nestedMeta = await createGitMeta(nestedWorktreeDir);
    expect(nestedMeta).toEqual({
      source: "local",
      remoteUrl: "https://example.com/triggerdotdev/trigger.dev.git",
      commitAuthorName: "Test User",
      commitMessage: "nested worktree commit",
      commitRef: "release/nested",
      commitSha: nestedSha,
      dirty: false,
    });
  });
});
