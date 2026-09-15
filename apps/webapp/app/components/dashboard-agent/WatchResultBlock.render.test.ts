import type { WatchResultBlock as WatchResultBlockPayload } from "@internal/dashboard-agent-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchResultBlock } from "./WatchResultBlock";

/**
 * The confirmation is frozen at append time, so the markup a live watch produces is also
 * the markup a fired, expired or cancelled watch keeps showing. Nothing in it may animate.
 */

function block(outcome: WatchResultBlockPayload["outcome"]): WatchResultBlockPayload {
  return {
    type: "watch_result",
    outcome,
    headline: "Watching run r_1 until it finishes.",
    lifetime: outcome === "watching" ? "Checks every 5 minutes for up to 2 hours." : null,
    detail: null,
    followUp: [],
    watchId: outcome === "watching" ? "watch_1" : null,
  };
}

function markup(outcome: WatchResultBlockPayload["outcome"]) {
  return renderToStaticMarkup(createElement(WatchResultBlock, { block: block(outcome) }));
}

describe("the watch confirmation block", () => {
  it("renders a live watch's label static, so it doesn't keep animating once the watch ends", () => {
    const html = markup("watching");
    expect(html).not.toContain("animate-text-shimmer");
    expect(html).toContain("Watch");
    expect(html).toContain("Checks every 5 minutes for up to 2 hours.");
  });

  it("renders the terminal outcomes static too", () => {
    for (const outcome of ["already_true", "impossible"] as const) {
      expect(markup(outcome)).not.toContain("animate-text-shimmer");
    }
  });

  it("marks every outcome with an icon", () => {
    for (const outcome of ["watching", "already_true", "impossible"] as const) {
      expect(markup(outcome)).toContain("<svg");
    }
  });
});
