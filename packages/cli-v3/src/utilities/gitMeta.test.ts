import { describe, expect, it } from "vitest";
import { sanitizeGitRemoteUrl } from "./gitMeta.js";

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
