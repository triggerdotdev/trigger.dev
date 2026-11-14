import { describe, expect, it } from "vitest";
import {
  findCopyRefusal,
  findRefusedEnvironments,
  findUnauthorizedEnvironmentId,
  type WriteCheckEnvironment,
} from "../app/v3/writableEnvironments.js";

const prod: WriteCheckEnvironment = { id: "env_prod", type: "PRODUCTION", orgMember: null };
const staging: WriteCheckEnvironment = { id: "env_staging", type: "STAGING", orgMember: null };
const myDev: WriteCheckEnvironment = {
  id: "env_dev_me",
  type: "DEVELOPMENT",
  orgMember: { userId: "user_me" },
};
const otherDev: WriteCheckEnvironment = {
  id: "env_dev_other",
  type: "DEVELOPMENT",
  orgMember: { userId: "user_other" },
};
const projectEnvs = [prod, staging, myDev, otherDev];

// Shared env types are writable by any project member; a DEVELOPMENT env only by
// its owner; an id not in the project is never writable.
describe("findUnauthorizedEnvironmentId", () => {
  it("allows shared env types for any member", () => {
    expect(
      findUnauthorizedEnvironmentId(projectEnvs, ["env_prod", "env_staging"], "user_me")
    ).toBeNull();
  });

  it("allows a caller's own DEV env", () => {
    expect(findUnauthorizedEnvironmentId(projectEnvs, ["env_dev_me"], "user_me")).toBeNull();
  });

  it("rejects another user's DEV env (the cross-user injection vector)", () => {
    expect(findUnauthorizedEnvironmentId(projectEnvs, ["env_dev_other"], "user_me")).toBe(
      "env_dev_other"
    );
  });

  it("rejects a foreign DEV env even when mixed with allowed ones", () => {
    expect(
      findUnauthorizedEnvironmentId(
        projectEnvs,
        ["env_prod", "env_dev_me", "env_dev_other"],
        "user_me"
      )
    ).toBe("env_dev_other");
  });

  it("rejects an id that isn't one of the project's environments", () => {
    expect(findUnauthorizedEnvironmentId(projectEnvs, ["env_not_in_project"], "user_me")).toBe(
      "env_not_in_project"
    );
  });
});

describe("findRefusedEnvironments", () => {
  const canWrite = (type: string) => type !== "PRODUCTION";

  // Catches: a batch write let through because some of its environments are allowed, or a
  // refused environment missing from the answer.
  it("lists every refused environment with its reason, among allowed ones", () => {
    expect(
      findRefusedEnvironments(
        projectEnvs,
        ["env_staging", "env_prod", "env_dev_me", "env_dev_other", "env_not_in_project"],
        "user_me",
        canWrite
      )
    ).toEqual([
      { id: "env_prod", reason: "noPermission", environment: prod },
      { id: "env_dev_other", reason: "notOwner", environment: otherDev },
      { id: "env_not_in_project", reason: "notFound" },
    ]);
  });

  it("is empty when every environment is writable", () => {
    expect(
      findRefusedEnvironments(projectEnvs, ["env_staging", "env_dev_me"], "user_me", canWrite)
    ).toEqual([]);
  });
});

// Catches: a copy that reads a source the role can't read, writes a target it can't write, or
// takes an environment from outside the project.
describe("findCopyRefusal", () => {
  const check = (
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
    { canRead = true, canWriteProd = true }: { canRead?: boolean; canWriteProd?: boolean } = {}
  ) =>
    findCopyRefusal(projectEnvs, {
      sourceEnvironmentId,
      targetEnvironmentId,
      userId: "user_me",
      canReadType: () => canRead,
      canWriteType: (type) => canWriteProd || type !== "PRODUCTION",
      title: (environment) => environment.type,
    });

  it("allows reading one shared or own environment and writing another", () => {
    expect(check("env_staging", "env_prod")).toBeNull();
    expect(check("env_dev_me", "env_staging")).toBeNull();
  });

  it("refuses a source or target outside the project, or the same environment twice", () => {
    expect(check("env_elsewhere", "env_prod")).toMatch(/copy from wasn't found/);
    expect(check("env_staging", "env_elsewhere")).toMatch(/copy to wasn't found/);
    expect(check("env_prod", "env_prod")).toMatch(/two different environments/);
  });

  it("refuses a source the role can't read, including another member's Development", () => {
    expect(check("env_staging", "env_prod", { canRead: false })).toBe(
      "Nothing was copied. You don't have permission to view environment variables in STAGING."
    );
    expect(check("env_dev_other", "env_prod")).toMatch(/view environment variables in DEVELOPMENT/);
  });

  it("refuses a target the role can't write, including another member's Development", () => {
    expect(check("env_staging", "env_prod", { canWriteProd: false })).toBe(
      "Nothing was copied. You don't have permission to change environment variables in PRODUCTION."
    );
    expect(check("env_staging", "env_dev_other")).toMatch(
      /change environment variables in DEVELOPMENT/
    );
  });
});
