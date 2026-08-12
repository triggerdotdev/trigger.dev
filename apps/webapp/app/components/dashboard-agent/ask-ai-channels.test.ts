import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentDeepLinkParams,
  aiHelpDocsUrl,
  aiHelpRedirectUrl,
  askAiCanOpen,
  askAiChannelTarget,
} from "./ask-ai-channels";

const CLOUD = { isManagedCloud: true, kapaWebsiteId: "kapa-id" };
const SELF_HOSTED = { isManagedCloud: false, kapaWebsiteId: "kapa-id" };
const CLOUD_UNCONFIGURED = { isManagedCloud: true, kapaWebsiteId: undefined };

describe("askAiCanOpen", () => {
  it("needs managed cloud and a website id", () => {
    expect(askAiCanOpen(CLOUD)).toBe(true);
    expect(askAiCanOpen(SELF_HOSTED)).toBe(false);
    expect(askAiCanOpen(CLOUD_UNCONFIGURED)).toBe(false);
    expect(askAiCanOpen({ isManagedCloud: true, kapaWebsiteId: "" })).toBe(false);
  });
});

/**
 * ⌘I and the CLI's help link are Ask AI's. Neither may dead-end where Kapa cannot load, so
 * both fall through to the dashboard agent instead of doing nothing.
 */
describe("askAiChannelTarget", () => {
  it("gives the channel to Ask AI where it can open", () => {
    expect(askAiChannelTarget(CLOUD)).toBe("ask-ai");
  });

  it("falls through to the agent on self-hosted", () => {
    expect(askAiChannelTarget(SELF_HOSTED)).toBe("dashboard-agent");
  });

  it("falls through to the agent when no website id is configured", () => {
    expect(askAiChannelTarget(CLOUD_UNCONFIGURED)).toBe("dashboard-agent");
  });
});

/**
 * Both surfaces are mounted on an environment page and both read the URL; whichever reads
 * `aiHelp` first deletes it, so exactly one of them may be watching for it. The agent is
 * otherwise reached by explicit invocation only — it owns no deep link of its own.
 */
describe("agentDeepLinkParams", () => {
  it("reads no deep link at all where Ask AI can open", () => {
    expect(agentDeepLinkParams(CLOUD)).toEqual([]);
  });

  it("picks `aiHelp` up itself where Ask AI cannot", () => {
    expect(agentDeepLinkParams(SELF_HOSTED)).toEqual(["aiHelp"]);
    expect(agentDeepLinkParams(CLOUD_UNCONFIGURED)).toEqual(["aiHelp"]);
  });

  it("never claims the retired `ask` param", () => {
    expect(agentDeepLinkParams(CLOUD)).not.toContain("ask");
    expect(agentDeepLinkParams(SELF_HOSTED)).not.toContain("ask");
  });

  it("returns a stable identity, so the reader's effect does not re-run every render", () => {
    expect(agentDeepLinkParams(CLOUD)).toBe(agentDeepLinkParams(CLOUD));
    expect(agentDeepLinkParams(SELF_HOSTED)).toBe(agentDeepLinkParams(SELF_HOSTED));
  });
});

describe("aiHelpRedirectUrl", () => {
  const url = aiHelpRedirectUrl({
    environmentPath: "/orgs/acme/projects/api/env/dev",
    origin: "https://cloud.trigger.dev",
    query: "Error: task timed out & failed",
  });

  it("carries the question in the param Ask AI reads", () => {
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

/**
 * Structural guard, not behavioural proof: these assert the wiring is present in source, not
 * that a keystroke or a redirect does the right thing at runtime.
 */
describe("wiring", () => {
  const appLayout = readFileSync(new URL("../../routes/_app/route.tsx", import.meta.url), "utf8");
  const agent = readFileSync(new URL("./DashboardAgent.tsx", import.meta.url), "utf8");
  const askAI = readFileSync(new URL("../AskAI.tsx", import.meta.url), "utf8");
  const cliRoute = readFileSync(
    new URL("../../routes/projects.$projectRef.ai-help.ts", import.meta.url),
    "utf8"
  );

  it("mounts `AskAIRoot` in the `_app` layout as a sibling of the app, not a wrapper", () => {
    expect(appLayout).toContain("<AskAIRoot />");
    expect(appLayout).not.toContain("<AskAIRoot>");
  });

  it("gives `AskAIRoot` no children to render", () => {
    expect(askAI).toContain("export function AskAIRoot() {");
  });

  it("gates the agent's ⌘I on owning the channel", () => {
    const registration = agent.slice(
      agent.indexOf("shortcut: ASK_AI_SHORTCUT"),
      agent.lastIndexOf("useDashboardAgentOpenRequests")
    );
    expect(registration).toContain("!ownsAskAiChannels");
  });

  it("registers ⌘I in Ask AI's own provider", () => {
    expect(askAI).toContain("shortcut: ASK_AI_SHORTCUT");
  });

  it("builds the CLI redirect through the shared helper", () => {
    expect(cliRoute).toContain("aiHelpRedirectUrl(");
  });

  // Structural: the loader needs a session and a database, so the branch is asserted on source.
  it("sends the CLI link to the docs when neither surface can open it", () => {
    expect(cliRoute).toContain("if (!canOpenSomething)");
    expect(cliRoute).toContain("redirect(aiHelpDocsUrl(query))");
    expect(cliRoute).toContain("askAiCanOpen(");
    expect(cliRoute).toContain("canAccessDashboardAgent(");
  });
});

describe("aiHelpDocsUrl", () => {
  it("carries the question to the docs", () => {
    const url = new URL(aiHelpDocsUrl("Error: task timed out & failed"));

    expect(url.origin + url.pathname).toBe("https://trigger.dev/docs");
    expect(url.searchParams.get("q")).toBe("Error: task timed out & failed");
  });
});
