import { viewBlockSchema, watchSpecSchema } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { wakeRefFromMessageId } from "~/components/dashboard-agent/WakeBanner";
import {
  watchConfirmationBlockBody,
  watchOneShotBlockBody,
} from "~/components/dashboard-agent/watch-presentation";
import { resolveTriggerUri, type TriggerUriScope } from "~/services/resolveTriggerUri.server";
import {
  buildAgentExampleChats,
  buildShowcaseWatches,
  SHOWCASE_CHAT_SLUG,
  showcaseWatchSpecs,
  type AgentExamplesWorld,
} from "../seed-agent-examples-chats.mjs";

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
    // `data-view` is the host's own card channel (the watch blocks): no tool
    // behind it, so it carries `data.blocks` instead of a tool state.
    const rendered = new Set(["text", "reasoning", "source-url", "data-view"]);
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
        expect(["diagnosis", "chart", "report", "investigation"], chat).toContain(block.type);
      }
    }
  });

  it("gives get_report a view model with the generatedAt the card requires", () => {
    const reports = parts().filter(({ part }) => part.type === "tool-get_report");
    expect(reports.length).toBe(3);
    for (const { chat, part } of reports) {
      const vm = (part.output as { vm: { generatedAt?: unknown } }).vm;
      // Without a string `generatedAt` the adapter rejects the block and the card
      // degrades to a plain tool row.
      expect(typeof vm.generatedAt, chat).toBe("string");
    }
  });

  it("stores every wake narration under a wake message id", () => {
    // A wake is spotted by its id, not by its parts, so an ordinary `msg_` id
    // would render as an answer to a question nobody asked — no banner.
    const wakes = chats.flatMap((chat) =>
      chat.messages
        .map((message) => ({ chat: chat.slug, ref: wakeRefFromMessageId(message.id) }))
        .filter((entry) => entry.ref !== null)
    );
    expect(wakes.map((entry) => entry.ref!.outcome)).toEqual(
      expect.arrayContaining(["fired", "expired"])
    );

    // Only an assistant turn can be a wake, and every conversation is started by
    // the user — an assistant message in first position has no turn to belong to.
    for (const entry of wakes) {
      const chat = chats.find((candidate) => candidate.slug === entry.chat)!;
      const message = chat.messages.find(
        (candidate) => wakeRefFromMessageId(candidate.id)?.watchId === entry.ref!.watchId
      )!;
      expect(message.role, `${entry.chat}/${message.id}`).toBe("assistant");
    }
    for (const chat of chats) {
      expect(chat.messages[0]!.role, `${chat.slug} opens`).toBe("user");
    }
  });

  it("never points prose at UI the panel no longer renders", () => {
    // A landed tool call leaves no row, and text has no raw toggle — so prose
    // that says "see the call above" or "show raw" describes a panel that is gone.
    const forbidden = [
      /show raw/i,
      /raw (json|output|input)/i,
      /expand(ed)? (the )?(tool|output)/i,
      /\btool (call|row)s? (above|below)\b/i,
      /you can see (it|the) call/i,
    ];
    for (const { chat, part } of parts()) {
      if (part.type !== "text" && part.type !== "reasoning") continue;
      const value = part.text as string;
      for (const pattern of forbidden) {
        expect(pattern.test(value), `${chat}: ${pattern} in ${value.slice(0, 80)}`).toBe(false);
      }
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

  it("validates every showcase card against the emitted-block schema", () => {
    // The showcase is the one transcript written entirely to today's rules, so it
    // can be held to the strict schema: envelope required, evidence as canonical
    // URIs, remediation only on a concluded investigation. The renderer doesn't
    // parse, so an invalid block would silently render as a broken card.
    const showcase = chats.find((chat) => chat.slug === SHOWCASE_CHAT_SLUG)!;
    const blocks = (showcase.messages.flatMap((message) => message.parts) as Part[]).flatMap(
      (part) => {
        if (part.type === "tool-render_view") {
          return (part.output as { blocks: unknown[] }).blocks;
        }
        if (part.type === "data-view") return (part.data as { blocks: unknown[] }).blocks;
        return [];
      }
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const parsed = viewBlockSchema.safeParse(block);
      expect(
        parsed.success,
        `${(block as { type?: string }).type}: ${
          parsed.success ? "" : JSON.stringify(parsed.error.issues)
        }`
      ).toBe(true);
    }
  });

  it("collapses the showcase investigation to one card, latest revision winning", () => {
    // Two revisions of the SAME id: the working copy and the verdict. Different
    // ids would stack two near-duplicate cards, which is the bug this guards.
    const showcase = chats.find((chat) => chat.slug === SHOWCASE_CHAT_SLUG)!;
    const investigations = showcase.messages
      .flatMap((message) => message.parts as Part[])
      .filter((part) => part.type === "tool-render_view")
      .flatMap((part) => (part.output as { blocks: Array<Record<string, unknown>> }).blocks)
      .filter((block) => block.type === "investigation");

    expect(investigations).toHaveLength(2);
    expect(new Set(investigations.map((block) => block.id)).size).toBe(1);
    expect(investigations.map((block) => block.revision)).toEqual([0, 1]);
    expect(
      investigations.map((block) => (block.investigation as { outcome: string }).outcome)
    ).toEqual(["in_progress", "concluded"]);

    // A concluded card has to be grounded: an error citation and a source
    // citation are what make it more than an assertion.
    const concluded = investigations[1]!.investigation as {
      remediation?: string;
      evidence: Array<{ kind: string }>;
    };
    expect(concluded.remediation).toBeTruthy();
    const kinds = concluded.evidence.map((evidence) => evidence.kind);
    expect(kinds).toContain("error");
    expect(kinds).toContain("source");
  });

  it("keeps the showcase's frozen watch wording in step with the presenter", () => {
    // A watch block carries final English rather than a key, so the seeded
    // strings are copies. If the presenter's wording moves, these must move with
    // it — otherwise the showcase teaches a sentence the product no longer says.
    const showcase = chats.find((chat) => chat.slug === SHOWCASE_CHAT_SLUG)!;
    const specs = showcaseWatchSpecs(WORLD);
    const blocks = showcase.messages
      .flatMap((message) => message.parts as Part[])
      .filter((part) => part.type === "data-view")
      .flatMap((part) => (part.data as { blocks: Array<Record<string, unknown>> }).blocks);

    expect(blocks.map((block) => block.outcome)).toEqual(["watching", "watching", "already_true"]);

    const watchRows = buildShowcaseWatches(WORLD);
    const expected = [
      watchConfirmationBlockBody({ spec: specs.drain, watchId: watchRows[0]!.id }),
      watchConfirmationBlockBody({
        spec: specs.recurrence,
        watchId: watchRows[1]!.id,
        followUp: { investigateOnAttention: true },
      }),
      watchOneShotBlockBody({ spec: specs.finishedRun, result: "satisfied" }),
    ];
    for (const [index, body] of expected.entries()) {
      const { id, revision, version, ...seeded } = blocks[index]!;
      expect(seeded, `block ${index}`).toEqual(body);
      expect(typeof id === "string" && id.startsWith("watch:"), `block ${index} id`).toBe(true);
      expect(revision, `block ${index} revision`).toBe(0);
      expect(version, `block ${index} version`).toBe(1);
    }
  });

  it("backs the showcase's wake with a watch row the banner can read", () => {
    const showcase = chats.find((chat) => chat.slug === SHOWCASE_CHAT_SLUG)!;
    const rows = buildShowcaseWatches(WORLD);
    const wakes = showcase.messages
      .map((message) => wakeRefFromMessageId(message.id))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null);

    expect(wakes).toHaveLength(1);
    const fired = rows.find((row) => row.id === wakes[0]!.watchId);
    // Without a row the banner falls back to kind-agnostic wording, which is
    // exactly the tone the showcase exists to demonstrate.
    expect(fired, "the wake's watch row").toBeDefined();
    expect(fired!.status).toBe("fired");
    expect(fired!.resolution).toBe("condition_met");
    expect(fired!.observedOutcome).not.toBeNull();
    expect(fired!.deliveryStatus).toBe("delivered");

    // The other row is still running — that's the live chip on the chat header.
    const active = rows.filter((row) => row.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.expiresInMinutes).toBeGreaterThan(0);

    // Every row's spec has to be a real one, or the check would never run.
    for (const row of rows) {
      expect(watchSpecSchema.safeParse(row.spec).success, row.id).toBe(true);
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
