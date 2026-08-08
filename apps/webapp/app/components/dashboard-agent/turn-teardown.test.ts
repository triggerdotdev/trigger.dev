import { readFileSync } from "node:fs";
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

/**
 * Structural guards, not behavioural proof: the wiring depends on when React runs the cleanup
 * relative to the router, which these assertions pin down without rendering anything.
 */
describe("the chat cancels its turn only on the teardowns that say so", () => {
  const chat = readFileSync(new URL("./DashboardAgentChat.tsx", import.meta.url), "utf8");

  it("decides through the shared rule rather than unmounting straight into a stop", () => {
    expect(chat).toContain("teardownCancelsTurn(");
    expect(chat).toContain("unmountTeardown({");
  });

  it("compares the last rendered path against the live one", () => {
    expect(chat).toContain("renderedPath: renderedPathRef.current");
    expect(chat).toContain("livePath: window.location.pathname");
  });

  // Where "filtering a page is not leaving it" actually lives: both sides are pathnames, so a
  // query string never reaches the comparison. Widen either side and a filter change reads as a
  // navigation, cancelling the turn.
  it("tracks the rendered path without its query string", () => {
    expect(chat).toContain("useRef(location.pathname)");
    expect(chat).toContain("renderedPathRef.current = location.pathname;");
    expect(chat).not.toContain("location.search");
  });

  it("runs the cleanup once, not on every path change", () => {
    const teardown = chat.slice(chat.indexOf("const teardownRef"));
    expect(teardown).toMatch(
      /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*teardownRef\.current\(\),\s*\[\]\)/
    );
  });

  it("cancels nothing when no turn is in flight", () => {
    expect(chat).toContain('if (status !== "streaming" && status !== "submitted") return;');
  });
});
