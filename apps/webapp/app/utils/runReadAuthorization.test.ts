import { buildJwtAbility } from "@trigger.dev/rbac";
import { describe, expect, it } from "vitest";
import { canReadRunWithAliases } from "./runReadAuthorization";

const run = {
  friendlyId: "run_child",
  taskIdentifier: "child-task",
  runTags: ["user:alice", "paid"],
  batchId: "abcdefghijklmnopqrstuvwx",
};

describe("canReadRunWithAliases", () => {
  it.each([
    "read:runs:run_child",
    "read:tasks:child-task",
    "read:tags:user:alice",
    "read:batch:batch_abcdefghijklmnopqrstuvwx",
    "read:runs",
  ])("allows child metadata through the %s alias", (scope) => {
    expect(canReadRunWithAliases(buildJwtAbility([scope]), run)).toBe(true);
  });

  it.each([
    "read:runs:run_parent",
    "read:tasks:parent-task",
    "read:tags:user:bob",
    "read:batch:batch_other",
  ])("denies child metadata when only %s is authorized", (scope) => {
    expect(canReadRunWithAliases(buildJwtAbility([scope]), run)).toBe(false);
  });

  it("checks all 13 bounded aliases in one ability call", () => {
    const runWithMaxTags = {
      ...run,
      runTags: Array.from({ length: 10 }, (_, index) => `tag:${index}`),
    };
    let checks = 0;

    expect(
      canReadRunWithAliases(
        {
          can(action, resources) {
            checks++;
            expect(action).toBe("read");
            expect(resources).toHaveLength(13);
            return false;
          },
          canSuper: () => false,
        },
        runWithMaxTags
      )
    ).toBe(false);
    expect(checks).toBe(1);
  });
});
