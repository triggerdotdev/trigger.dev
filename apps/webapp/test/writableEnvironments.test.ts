import { describe, expect, it } from "vitest";
import {
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
