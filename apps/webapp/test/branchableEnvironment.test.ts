import { describe, expect, it } from "vitest";
import {
  isBranchableEnvironment,
  rootEnvironmentWhere,
  toBranchableEnvironmentType,
} from "~/utils/branchableEnvironment";

describe("toBranchableEnvironmentType", () => {
  it("maps the wire tokens to the canonical Prisma enum", () => {
    expect(toBranchableEnvironmentType("preview")).toBe("PREVIEW");
    expect(toBranchableEnvironmentType("development")).toBe("DEVELOPMENT");
  });
});

describe("isBranchableEnvironment", () => {
  it("treats any DEVELOPMENT root as branchable, ignoring the column", () => {
    // The dev migration dropped the column-based approach: branchability for
    // dev is derived structurally, so a root with the column unset is still
    // branchable.
    expect(
      isBranchableEnvironment({
        type: "DEVELOPMENT",
        parentEnvironmentId: null,
        isBranchableEnvironment: false,
      })
    ).toBe(true);
  });

  it("never treats a dev BRANCH (one with a parent) as branchable", () => {
    // Load-bearing guard: dev branches are also type DEVELOPMENT, so checking
    // the type alone would misclassify them. The parentEnvironmentId guard is
    // what prevents branches-of-branches.
    expect(
      isBranchableEnvironment({
        type: "DEVELOPMENT",
        parentEnvironmentId: "env_parent",
        isBranchableEnvironment: true,
      })
    ).toBe(false);
  });

  it("honors the column for PREVIEW roots (the long-standing source of truth)", () => {
    expect(
      isBranchableEnvironment({
        type: "PREVIEW",
        parentEnvironmentId: null,
        isBranchableEnvironment: true,
      })
    ).toBe(true);

    expect(
      isBranchableEnvironment({
        type: "PREVIEW",
        parentEnvironmentId: null,
        isBranchableEnvironment: false,
      })
    ).toBe(false);
  });

  it("never treats a preview branch as branchable, even with the column set", () => {
    expect(
      isBranchableEnvironment({
        type: "PREVIEW",
        parentEnvironmentId: "env_parent",
        isBranchableEnvironment: true,
      })
    ).toBe(false);
  });

  it("is false for STAGING and PRODUCTION", () => {
    for (const type of ["STAGING", "PRODUCTION"] as const) {
      expect(
        isBranchableEnvironment({
          type,
          parentEnvironmentId: null,
          isBranchableEnvironment: true,
        })
      ).toBe(false);
    }
  });
});

describe("rootEnvironmentWhere", () => {
  it("matches the root env of the type (never a branch)", () => {
    expect(rootEnvironmentWhere("PREVIEW")).toEqual({
      type: "PREVIEW",
      parentEnvironmentId: null,
    });
  });

  it("scopes DEVELOPMENT roots by org member when a userId is given", () => {
    // Dev roots are per-org-member, so the same project has one root per user.
    expect(rootEnvironmentWhere("DEVELOPMENT", { userId: "user_123" })).toEqual({
      type: "DEVELOPMENT",
      parentEnvironmentId: null,
      orgMember: { userId: "user_123" },
    });
  });

  it("omits the org-member filter for DEVELOPMENT when no userId is given", () => {
    expect(rootEnvironmentWhere("DEVELOPMENT")).toEqual({
      type: "DEVELOPMENT",
      parentEnvironmentId: null,
    });
  });

  it("ignores userId for non-development types", () => {
    expect(rootEnvironmentWhere("PREVIEW", { userId: "user_123" })).toEqual({
      type: "PREVIEW",
      parentEnvironmentId: null,
    });
  });
});
