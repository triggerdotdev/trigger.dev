import { describe, expect, it } from "vitest";
import { agentDeepLinkParams, aiHelpDocsUrl, aiHelpRedirectUrl } from "./ask-ai-channels";

describe("agentDeepLinkParams", () => {
  it("always reads `aiHelp`", () => {
    expect(agentDeepLinkParams()).toEqual(["aiHelp"]);
  });

  it("returns a stable identity, so the reader's effect does not re-run every render", () => {
    expect(agentDeepLinkParams()).toBe(agentDeepLinkParams());
  });
});

describe("aiHelpRedirectUrl", () => {
  const url = aiHelpRedirectUrl({
    environmentPath: "/orgs/acme/projects/api/env/dev",
    origin: "https://cloud.trigger.dev",
    query: "Error: task timed out & failed",
  });

  it("carries the question in the param the agent reads", () => {
    expect(new URL(url).searchParams.get("aiHelp")).toBe("Error: task timed out & failed");
  });

  it("lands on the environment page", () => {
    expect(url.startsWith("https://cloud.trigger.dev/orgs/acme/projects/api/env/dev?")).toBe(true);
  });

  /**
   * The only caller passes a path its own builder made, so none of these are reachable today.
   * The guard is here rather than at the `redirect()` because this helper is the one place both
   * that route and any future caller go through, and it is the only pure one of the two.
   */
  it("stays on `origin` whatever shape the path arrives in", () => {
    const off = (environmentPath: string) =>
      new URL(
        aiHelpRedirectUrl({
          environmentPath,
          origin: "https://cloud.trigger.dev",
          query: "why",
        })
      );

    expect(off("https://evil.example/steal").origin).toBe("https://cloud.trigger.dev");
    expect(off("//evil.example/steal").origin).toBe("https://cloud.trigger.dev");
    expect(off("https://evil.example//steal").origin).toBe("https://cloud.trigger.dev");
    expect(off("javascript:alert(1)").origin).toBe("https://cloud.trigger.dev");
  });

  it("keeps the path, search and fragment of a normal internal path", () => {
    const parsed = new URL(
      aiHelpRedirectUrl({
        environmentPath: "/orgs/acme/projects/api/env/dev?tab=runs#top",
        origin: "https://cloud.trigger.dev",
        query: "why",
      })
    );

    expect(parsed.pathname).toBe("/orgs/acme/projects/api/env/dev");
    expect(parsed.searchParams.get("tab")).toBe("runs");
    expect(parsed.searchParams.get("aiHelp")).toBe("why");
    expect(parsed.hash).toBe("#top");
  });
});

describe("aiHelpDocsUrl", () => {
  it("carries the question to the docs", () => {
    const url = new URL(aiHelpDocsUrl("Error: task timed out & failed"));

    expect(url.origin + url.pathname).toBe("https://trigger.dev/docs");
    expect(url.searchParams.get("q")).toBe("Error: task timed out & failed");
  });
});
