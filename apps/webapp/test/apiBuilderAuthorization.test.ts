import { buildJwtAbility } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  checkAuth,
  everyResource,
  shouldRejectRestrictedKeyWithoutAuthorization,
} from "~/services/routeBuilders/apiBuilder.server";

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
