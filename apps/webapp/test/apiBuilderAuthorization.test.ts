import { buildJwtAbility } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  boundaryErrorLogValue,
  checkAuth,
  everyResource,
  shouldRejectRestrictedKeyWithoutAuthorization,
} from "~/services/routeBuilders/apiBuilder.server";

describe("API boundary error logging", () => {
  it("redacts structurally recognized Drizzle query errors without changing them", () => {
    const query = "select * from secrets where token = $1";
    const params = ["secret-value"];
    const cause = { code: "23505", detail: "secret-detail" };
    const error = Object.assign(new Error(`Failed query: ${query}`), {
      query,
      params,
      cause,
    });
    error.stack = `Error: Failed query: ${query}\nsecret-stack`;

    expect(boundaryErrorLogValue(error)).toEqual({
      name: "DrizzleQueryError",
      message: "Database query failed",
      causeCode: "23505",
    });
    expect(error.message).toBe(`Failed query: ${query}`);
    expect(error.query).toBe(query);
    expect(error.params).toBe(params);
    expect(error.cause).toBe(cause);
  });

  it("omits non-scalar cause codes", () => {
    const error = Object.assign(new Error("Failed query: select 1"), {
      query: "select 1",
      params: [],
      cause: { code: { private: "value" } },
    });

    expect(boundaryErrorLogValue(error)).toEqual({
      name: "DrizzleQueryError",
      message: "Database query failed",
    });
  });
});

describe("restricted API key route authorization", () => {
  it("fails closed when a route has no authorization declaration", () => {
    expect(shouldRejectRestrictedKeyWithoutAuthorization(true, false)).toBe(true);
    expect(shouldRejectRestrictedKeyWithoutAuthorization(true, true)).toBe(false);
    expect(shouldRejectRestrictedKeyWithoutAuthorization(false, false)).toBe(false);
  });
});

describe("everyResource authorization", () => {
  it("requires an ID-scoped ability to match every requested resource", () => {
    const ability = buildJwtAbility(["read:tasks:task-a"]);

    expect(
      checkAuth(
        ability,
        "read",
        everyResource(
          [
            { type: "tasks", id: "task-a" },
            { type: "tasks", id: "task-b" },
          ],
          [{ type: "runs" }, { type: "tasks" }]
        )
      )
    ).toBe(false);
  });

  it("allows an ID-scoped ability when every requested resource matches", () => {
    const ability = buildJwtAbility(["read:tasks:task-a", "read:tasks:task-b"]);

    expect(
      checkAuth(
        ability,
        "read",
        everyResource(
          [
            { type: "tasks", id: "task-a" },
            { type: "tasks", id: "task-b" },
          ],
          [{ type: "runs" }, { type: "tasks" }]
        )
      )
    ).toBe(true);
  });

  it("preserves broad collection grants as an alternative", () => {
    const ability = buildJwtAbility(["read:runs"]);

    expect(
      checkAuth(
        ability,
        "read",
        everyResource(
          [
            { type: "tasks", id: "task-a" },
            { type: "tasks", id: "task-b" },
          ],
          [{ type: "runs" }, { type: "tasks" }]
        )
      )
    ).toBe(true);
  });
});
