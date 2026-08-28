import { describe, expect, it } from "vitest";
import { selectAccessibleEnvironment } from "./environmentAccess";

const USER_ID = "user_owner";
const OTHER_USER_ID = "user_other";

function devEnvironment(id: string, userId: string | null) {
  return {
    id,
    type: "DEVELOPMENT" as const,
    orgMember: userId === null ? null : { userId },
  };
}

function prodEnvironment(id: string) {
  return { id, type: "PRODUCTION" as const, orgMember: null };
}

describe("selectAccessibleEnvironment", () => {
  it("returns the caller's own development environment", () => {
    const own = devEnvironment("env_own", USER_ID);

    expect(selectAccessibleEnvironment([own], USER_ID)).toBe(own);
  });

  it("skips a development environment belonging to another member", () => {
    const theirs = devEnvironment("env_theirs", OTHER_USER_ID);

    expect(selectAccessibleEnvironment([theirs], USER_ID)).toBeUndefined();
  });

  it("picks the caller's development environment past another member's", () => {
    const theirs = devEnvironment("env_theirs", OTHER_USER_ID);
    const own = devEnvironment("env_own", USER_ID);

    expect(selectAccessibleEnvironment([theirs, own], USER_ID)).toBe(own);
  });

  it("skips a development environment whose member has been deleted", () => {
    const orphaned = devEnvironment("env_orphaned", null);

    expect(selectAccessibleEnvironment([orphaned], USER_ID)).toBeUndefined();
  });

  it("returns a shared environment regardless of who owns it", () => {
    const prod = prodEnvironment("env_prod");

    expect(selectAccessibleEnvironment([prod], USER_ID)).toBe(prod);
  });

  it("returns undefined when there are no environments", () => {
    expect(selectAccessibleEnvironment([], USER_ID)).toBeUndefined();
  });
});
