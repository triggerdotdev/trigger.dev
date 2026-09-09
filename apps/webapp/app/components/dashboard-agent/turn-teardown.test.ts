import { describe, expect, it } from "vitest";
import { teardownCancelsTurn, unmountTeardown } from "./turn-teardown";

describe("teardownCancelsTurn", () => {
  it("cancels when the user clicks Stop", () => {
    expect(teardownCancelsTurn("stop-clicked")).toBe(true);
  });

  it("keeps the turn when the panel closes", () => {
    expect(teardownCancelsTurn("panel-closed")).toBe(false);
  });

  it("keeps the turn when the panel changes chat", () => {
    expect(teardownCancelsTurn("chat-switched")).toBe(false);
  });

  it("cancels when the user has left the page", () => {
    expect(teardownCancelsTurn("navigated-away")).toBe(true);
  });
});

describe("unmountTeardown", () => {
  const path = "/orgs/acme/projects/api/env/prod/runs";

  it("reads an unmount on the same path as the panel closing", () => {
    expect(unmountTeardown({ renderedPath: path, livePath: path })).toBe("panel-closed");
  });

  it("reads an unmount after the URL moved as a navigation", () => {
    expect(unmountTeardown({ renderedPath: path, livePath: "/orgs/acme/settings" })).toBe(
      "navigated-away"
    );
  });
});
