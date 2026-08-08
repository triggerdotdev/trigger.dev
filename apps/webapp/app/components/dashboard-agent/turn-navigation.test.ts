import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { navigateIntentApplies, takeNavigateIntent } from "./turn-navigation";

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

describe("takeNavigateIntent", () => {
  const target = "trigger://proj_abc/env_123/run/run_abc";

  function messages() {
    return [
      {
        id: "msg_1",
        parts: [
          {
            type: "tool-navigate_to",
            state: "output-available",
            toolCallId: "call_1",
            output: { intent: { kind: "navigate", target } },
          },
        ],
      },
    ];
  }

  it("takes the navigation on the page the turn was asked for", () => {
    const taken = takeNavigateIntent({
      messages: messages(),
      handled: new Set(),
      startedPath: runs,
      currentPath: runs,
    });
    expect(taken).toMatchObject({ kind: "navigate", target });
  });

  it("takes nothing once the user has walked to another screen", () => {
    expect(
      takeNavigateIntent({
        messages: messages(),
        handled: new Set(),
        startedPath: runs,
        currentPath: queues,
      })
    ).toBeUndefined();
  });

  // The property the panel depends on: a commit that drops a navigation still consumes it, so
  // walking back to the page it was asked on does not make it fire late.
  it("marks a dropped navigation handled, so a later commit cannot fire it", () => {
    const handled = new Set<string>();
    const parts = messages();

    expect(
      takeNavigateIntent({ messages: parts, handled, startedPath: runs, currentPath: queues })
    ).toBeUndefined();

    expect(
      takeNavigateIntent({ messages: parts, handled, startedPath: runs, currentPath: runs })
    ).toBeUndefined();
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
    expect(chat).toContain("takeNavigateIntent({");
    expect(chat).toContain("startedPath: turnStartedPathRef.current");
    expect(chat).not.toContain("pendingNavigateIntents(messages");
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
      chat.indexOf("takeNavigateIntent({")
    );
  });

  it("hands the persistent handled-set in, so drops are recorded across commits", () => {
    expect(chat).toContain("handled: navigatedRef.current!");
  });
});
