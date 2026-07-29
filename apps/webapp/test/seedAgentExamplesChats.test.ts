import { describe, expect, it } from "vitest";
import { resolveTriggerUri, type TriggerUriScope } from "~/services/resolveTriggerUri.server";
import { buildAgentExampleChats, type AgentExamplesWorld } from "../seed-agent-examples-chats.mjs";

/**
 * The example transcripts are hand-written JSON that the production renderer has
 * to display, and whose citations have to point at the seeded environment. Both
 * are silent failures — a wrong part shape renders as nothing, a wrong scope
 * renders a citation as plain text — so they're asserted here rather than found
 * by eye in the panel.
 */

const WORLD: AgentExamplesWorld = {
  organizationSlug: "agent-examples-1234",
  projectSlug: "agent-examples-ABcd",
  projectRef: "proj_agentexamplesseed01",
  environmentId: "cm000000000000000000000",
  environmentSlug: "prod",
  appOrigin: "http://localhost:3030",
  failedRunId: "run_aaaaaaaaaaaaaaaaaaaaa",
  failedSpanId: "1234567890abcdef",
  waitingRunId: "run_bbbbbbbbbbbbbbbbbbbbb",
  slowRunId: "run_ccccccccccccccccccccc",
  priorRunId: "run_ddddddddddddddddddddd",
  taskId: "send-order-receipt",
  slowTaskId: "generate-monthly-report",
  queue: "email-sends",
  backlogQueue: "reports-heavy",
  errorFingerprint: "c4b4a797397a9c43",
  deploymentVersion: "20260726.4",
  sourceSha: "9f3c1a2b7d4e6058ab1c2d3e4f5061728394a5b6",
  sourcePath: "src/trigger/sendOrderReceipt.ts",
  envConcurrencyLimit: 50,
  pinnedMinutes: 38,
  pending: 4_812,
  worstQueueShare: 0.71,
  failureCount: 279,
  failureRatePct: "0.6",
  donePerMin: 774,
  triggeredPerMin: 883,
  drainMinutes: 6,
  firstFailureClock: "09:02",
  lastFailureClock: "10:11",
  degradedReport: { title: "health", generatedAt: "2026-07-27T10:15:00.000Z" },
  healthyReport: { title: "health", generatedAt: "2026-07-27T07:15:00.000Z" },
};

const SCOPE: TriggerUriScope = {
  id: WORLD.environmentId,
  slug: WORLD.environmentSlug,
  project: { slug: WORLD.projectSlug, externalRef: WORLD.projectRef },
  organization: { slug: WORLD.organizationSlug },
};

/** Kinds `resolveTriggerUri` deliberately has no dashboard page for yet. */
const UNRESOLVABLE_KINDS = ["report", "source", "investigation"];

const chats = buildAgentExampleChats(WORLD);

type Part = { type: string; [key: string]: unknown };

function parts(): Array<{ chat: string; part: Part }> {
  return chats.flatMap((chat) =>
    chat.messages.flatMap((message) =>
      (message.parts as Part[]).map((part) => ({ chat: chat.slug, part }))
    )
  );
}

describe("agent example transcripts", () => {
  it("gives every chat a stable slug, a title and messages", () => {
    expect(chats.length).toBeGreaterThan(0);
    expect(new Set(chats.map((chat) => chat.slug)).size).toBe(chats.length);
    for (const chat of chats) {
      // The panel treats an empty transcript as "nothing stored" and drops back
      // to a fresh draft, so a stored chat must never be empty.
      expect(chat.messages.length, chat.slug).toBeGreaterThan(0);
      expect(chat.title, chat.slug).not.toHaveLength(0);
      for (const message of chat.messages) {
        expect(message.parts.length, `${chat.slug}/${message.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps message ids unique across the whole set", () => {
    const ids = chats.flatMap((chat) => chat.messages.map((message) => message.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses part shapes the production renderer displays", () => {
    const rendered = new Set(["text", "reasoning", "source-url"]);
    for (const { chat, part } of parts()) {
      if (rendered.has(part.type)) continue;
      expect(part.type.startsWith("tool-"), `${chat}: ${part.type}`).toBe(true);
      // An in-flight state would render as a tool row that never finishes.
      expect(part.state, `${chat}: ${part.type}`).toMatch(/^output-(available|error)$/);
      expect(part.toolCallId, `${chat}: ${part.type}`).toBeTruthy();
    }
  });

  it("gives render_view a non-empty block list of known types", () => {
    const blocks = parts()
      .filter(({ part }) => part.type === "tool-render_view")
      .map(({ chat, part }) => ({ chat, blocks: (part.output as { blocks: unknown[] }).blocks }));
    expect(blocks.length).toBeGreaterThan(0);
    for (const { chat, blocks: list } of blocks) {
      expect(Array.isArray(list) && list.length > 0, chat).toBe(true);
      for (const block of list as Array<{ type: string }>) {
        expect(["diagnosis", "chart", "report"], chat).toContain(block.type);
      }
    }
  });

  it("gives get_report a view model with the generatedAt the card requires", () => {
    const reports = parts().filter(({ part }) => part.type === "tool-get_report");
    expect(reports.length).toBe(2);
    for (const { chat, part } of reports) {
      const vm = (part.output as { vm: { generatedAt?: unknown } }).vm;
      // Without a string `generatedAt` the adapter rejects the block and the card
      // degrades to a plain tool row.
      expect(typeof vm.generatedAt, chat).toBe("string");
    }
  });

  it("resolves every trigger:// citation inside the seeded scope", () => {
    const text = JSON.stringify(chats);
    const uris = [...text.matchAll(/trigger:\/\/[^\s"`\\]+/g)].map((match) => match[0]);
    expect(uris.length).toBeGreaterThan(0);

    for (const uri of uris) {
      const kind = uri.split("/")[4];
      if (UNRESOLVABLE_KINDS.includes(kind)) continue;
      const resolved = resolveTriggerUri(SCOPE, uri);
      expect(resolved, uri).not.toBeNull();
      expect(resolved!.url, uri).toContain(WORLD.projectSlug);
    }
  });

  it("points every http citation at this environment or the public docs", () => {
    const urls = parts()
      .filter(({ part }) => part.type === "source-url")
      .map(({ part }) => part.url as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const local = url.startsWith(
        `${WORLD.appOrigin}/orgs/${WORLD.organizationSlug}/projects/${WORLD.projectSlug}/env/${WORLD.environmentSlug}/`
      );
      expect(local || url.startsWith("https://trigger.dev/docs/"), url).toBe(true);
    }
  });
});
