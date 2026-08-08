import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { navigateIntentApplies } from "./turn-navigation";

const runs = "/orgs/acme/projects/api/env/prod/runs";
const queues = "/orgs/acme/projects/api/env/prod/queues";

describe("navigateIntentApplies", () => {
  it("navigates when the user is still where the turn was asked for", () => {
    expect(navigateIntentApplies({ startedPath: runs, currentPath: runs })).toBe(true);
  });

  it("drops the navigation once the user has walked to another screen", () => {
    expect(navigateIntentApplies({ startedPath: runs, currentPath: queues })).toBe(false);
  });

  it("drops it when this tab never saw the turn start", () => {
    // A resumed turn: nothing here knows the page it was asked on.
    expect(navigateIntentApplies({ startedPath: null, currentPath: runs })).toBe(false);
  });
});

/**
 * Structural guards, not behavioural proof: whether the started-at path is still right when the
 * intent lands depends on effect order and on nothing clearing it, which these assertions pin
 * down without rendering anything.
 */
describe("the chat scopes a turn's navigation to the page it started on", () => {
  const chat = readFileSync(new URL("./DashboardAgentChat.tsx", import.meta.url), "utf8");

  it("gates the navigate intent on the shared rule", () => {
    expect(chat).toContain("navigateIntentApplies({");
    expect(chat).toContain("startedPath: turnStartedPathRef.current");
    expect(chat).not.toContain("if (target) void goTo(target);");
  });

  it("records the path only as a turn goes in flight", () => {
    expect(chat).toContain(
      "if (inFlight && !turnWasInFlight.current) turnStartedPathRef.current = renderedPathRef.current;"
    );
  });

  it("never clears the path on settle, which can share a commit with the intent", () => {
    const assignments = [...chat.matchAll(/turnStartedPathRef\.current = /g)];
    expect(assignments).toHaveLength(1);
  });

  it("records the path before the intent effect reads it", () => {
    expect(chat.indexOf("turnStartedPathRef.current = renderedPathRef.current")).toBeLessThan(
      chat.indexOf("navigateIntentApplies({")
    );
  });

  it("marks a dropped navigation handled, so it cannot fire on a later commit", () => {
    const effect = chat.slice(chat.indexOf("const pending = pendingNavigateIntents(messages"));
    expect(effect.indexOf("pendingNavigateIntents(messages")).toBeLessThan(
      effect.indexOf("navigateIntentApplies({")
    );
  });
});
