import { describe, expect, it } from "vitest";
import { sanitizeBranchName, isValidGitBranchName } from "../app/services/upsertBranch.server";

describe("isValidGitBranchName", () => {
  it("returns true for a valid branch name", async () => {
    expect(isValidGitBranchName("feature/valid-branch")).toBe(true);
  });

  it("returns false for an invalid branch name", async () => {
    expect(isValidGitBranchName("invalid branch name!")).toBe(false);
  });

  it("disallows control characters (ASCII 0–31)", async () => {
    for (let i = 0; i <= 31; i++) {
      const branch = `feature${String.fromCharCode(i)}branch`;
      // eslint-disable-next-line no-await-in-loop
      expect(isValidGitBranchName(branch)).toBe(false);
    }
  });

  it("disallows space", async () => {
    expect(isValidGitBranchName("feature branch")).toBe(false);
  });

  it("disallows tilde (~)", async () => {
    expect(isValidGitBranchName("feature~branch")).toBe(false);
  });

  it("disallows caret (^)", async () => {
    expect(isValidGitBranchName("feature^branch")).toBe(false);
  });

  it("disallows colon (:)", async () => {
    expect(isValidGitBranchName("feature:branch")).toBe(false);
  });

  it("disallows question mark (?)", async () => {
    expect(isValidGitBranchName("feature?branch")).toBe(false);
  });

  it("disallows asterisk (*)", async () => {
    expect(isValidGitBranchName("feature*branch")).toBe(false);
  });

  it("disallows open bracket ([)", async () => {
    expect(isValidGitBranchName("feature[branch")).toBe(false);
  });

  it("disallows backslash (\\)", async () => {
    expect(isValidGitBranchName("feature\\branch")).toBe(false);
  });

  it("disallows branch names that begin with a slash", async () => {
    expect(isValidGitBranchName("/feature-branch")).toBe(false);
  });

  it("disallows branch names that end with a slash", async () => {
    expect(isValidGitBranchName("feature-branch/")).toBe(false);
  });

  it("disallows consecutive slashes (//)", async () => {
    expect(isValidGitBranchName("feature//branch")).toBe(false);
  });

  it("disallows the sequence ..", async () => {
    expect(isValidGitBranchName("feature..branch")).toBe(false);
  });

  it("disallows @{ in the name", async () => {
    expect(isValidGitBranchName("feature@{branch")).toBe(false);
  });

  it("disallows names ending with .lock", async () => {
    expect(isValidGitBranchName("feature-branch.lock")).toBe(false);
  });
});

describe("branchNameFromRef", () => {
  it("returns the branch name for refs/heads/branch", async () => {
    const result = sanitizeBranchName("refs/heads/feature/branch");
    expect(result).toBe("feature/branch");
  });

  it("returns the branch name for refs/remotes/origin/branch", async () => {
    const result = sanitizeBranchName("refs/remotes/origin/feature/branch");
    expect(result).toBe("origin/feature/branch");
  });

  it("returns the tag name for refs/tags/v1.0.0", async () => {
    const result = sanitizeBranchName("refs/tags/v1.0.0");
    expect(result).toBe("v1.0.0");
  });

  it("returns the input if just a branch name is given", async () => {
    const result = sanitizeBranchName("feature/branch");
    expect(result).toBe("feature/branch");
  });

  it("returns null for an invalid ref", async () => {
    const result = sanitizeBranchName("refs/invalid/branch");
    expect(result).toBeNull();
  });

  it("returns null for an empty string", async () => {
    const result = sanitizeBranchName("");
    expect(result).toBeNull();
  });
});
