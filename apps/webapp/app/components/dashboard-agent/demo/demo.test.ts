import {
  agentIntentSchema,
  agentPageContextSchema,
  isRevisableBlock,
  safeParseStoredViewBlock,
  safeParseTriggerUri,
  suggestedPromptSchema,
  viewBlockSchema,
  watchIdentity,
  watchSpecSchema,
  SUGGESTED_PROMPT_CAP,
  type Evidence,
} from "@internal/dashboard-agent-contracts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoChats, demoHistoryChats } from "./demo-chats";
import * as fixtures from "./fixtures";
import { DEMO_ID_PREFIX, DEMO_MARKER } from "./ids";

const DEMO_DIR = __dirname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sourceFiles = walk(DEMO_DIR).filter(
  (path) => /\.(ts|tsx)$/.test(path) && !path.endsWith(".test.ts")
);

/** Every import specifier in a file, from both `import` and `export … from`. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g)].map(
    (match) => match[1]!
  );
}

describe("demo ids", () => {
  it("namespaces every chat id", () => {
    for (const chat of demoChats) {
      expect(chat.id.startsWith(DEMO_ID_PREFIX), chat.id).toBe(true);
    }
  });

  it("has no duplicate chat ids", () => {
    const ids = demoChats.map((chat) => chat.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("namespaces every message id", () => {
    for (const chat of demoChats) {
      for (const item of chat.items) {
        if (item.kind !== "messages") continue;
        for (const message of item.messages) {
          expect(message.id.startsWith(DEMO_ID_PREFIX), message.id).toBe(true);
        }
      }
    }
  });

  it("namespaces investigation, hypothesis, watch and prompt ids", () => {
    for (const investigation of Object.values(fixtures.demoInvestigations)) {
      expect(investigation.investigationId.startsWith(DEMO_ID_PREFIX)).toBe(true);
      for (const hypothesis of investigation.hypotheses) {
        expect(hypothesis.id.startsWith(DEMO_ID_PREFIX)).toBe(true);
      }
    }
    for (const watch of fixtures.demoWatches.row) {
      expect(watch.id.startsWith(DEMO_ID_PREFIX)).toBe(true);
    }
    for (const prompts of Object.values(fixtures.demoPromptSets)) {
      for (const prompt of prompts) {
        expect(prompt.id.startsWith(DEMO_ID_PREFIX)).toBe(true);
      }
    }
  });

  it("marks every resource id, so nothing can pass for a real one", () => {
    for (const value of Object.values(fixtures.demoViewBlocks)) {
      if (value.type === "diagnosis") {
        expect(value.runId).toContain(DEMO_MARKER);
      }
    }
    for (const id of Object.values({
      failedRunId: fixtures.demoInvestigationConcluded.runId,
      slowRunId: fixtures.demoInvestigationInconclusive.runId,
    })) {
      expect(id).toContain(DEMO_MARKER);
    }
  });

  it("exposes the history rows keyed by the same ids", () => {
    expect(demoHistoryChats.map((chat) => chat.id)).toEqual(demoChats.map((chat) => chat.id));
  });
});

describe("view block fixtures", () => {
  const blocks = Object.values(fixtures.demoViewBlocks);

  it("parses every block through the lenient stored-block schema", () => {
    for (const block of blocks) {
      const result = safeParseStoredViewBlock(block);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it("parses the enveloped blocks through the strict schema too", () => {
    for (const block of [
      fixtures.demoDiagnosisBlockFirstPass,
      fixtures.demoDiagnosisBlockRevised,
      fixtures.demoChartBlock,
    ]) {
      expect(viewBlockSchema.safeParse(block).success).toBe(true);
      expect(isRevisableBlock(block)).toBe(true);
    }
  });

  it("keeps one legacy, envelope-less block that is not revisable", () => {
    const legacy = fixtures.demoLegacyDiagnosisBlock;
    expect(viewBlockSchema.safeParse(legacy).success).toBe(false);
    expect(safeParseStoredViewBlock(legacy).success).toBe(true);
    expect(isRevisableBlock(legacy)).toBe(false);
  });

  it("revises a block by id rather than emitting a second one", () => {
    expect(fixtures.demoDiagnosisBlockRevised.id).toBe(fixtures.demoDiagnosisBlockFirstPass.id);
    expect(fixtures.demoDiagnosisBlockRevised.revision).toBeGreaterThan(
      fixtures.demoDiagnosisBlockFirstPass.revision
    );
  });
});

describe("investigation fixtures", () => {
  const investigations = Object.values(fixtures.demoInvestigations);

  const allEvidence = (): Evidence[] =>
    investigations.flatMap((investigation) => [
      ...investigation.evidence,
      ...investigation.hypotheses.flatMap((hypothesis) => hypothesis.evidence),
    ]);

  it("cites only valid trigger:// URIs, with the kind matching the URI", () => {
    for (const evidence of allEvidence()) {
      const parsed = safeParseTriggerUri(evidence.uri);
      expect(parsed.success, `${evidence.uri}: ${!parsed.success ? parsed.error : ""}`).toBe(true);
      if (parsed.success) expect(parsed.data.kind).toBe(evidence.kind);
      expect(evidence.uri).toContain(DEMO_MARKER);
    }
  });

  it("only offers a fix when it concluded, and only 'check next' when it didn't", () => {
    for (const investigation of investigations) {
      if (investigation.outcome === "concluded") {
        expect(investigation.remediation).toBeTruthy();
        expect(investigation.checkNext).toBeUndefined();
      } else {
        expect(investigation.remediation).toBeUndefined();
      }
      if (investigation.outcome === "inconclusive") {
        expect(investigation.checkNext?.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives the concluded card at least two settled hypotheses", () => {
    const settled = fixtures.demoInvestigationConcluded.hypotheses.filter(
      (hypothesis) => hypothesis.verdict !== "testing"
    );
    expect(settled.length).toBeGreaterThanOrEqual(2);
    expect(settled.some((h) => h.verdict === "validated")).toBe(true);
    expect(settled.some((h) => h.verdict === "invalidated")).toBe(true);
    expect(
      fixtures.demoInvestigationConcluded.hypotheses.every(
        (h) => h.verdict === "testing" || h.finding
      )
    ).toBe(true);
  });

  it("keeps a streaming revision with a hypothesis still testing", () => {
    expect(fixtures.demoInvestigationStreamingRev1.investigationId).toBe(
      fixtures.demoInvestigationStreamingRev0.investigationId
    );
    expect(fixtures.demoInvestigationStreamingRev1.revision).toBeGreaterThan(
      fixtures.demoInvestigationStreamingRev0.revision
    );
    expect(
      fixtures.demoInvestigationStreamingRev1.hypotheses.some((h) => h.verdict === "testing")
    ).toBe(true);
  });

  it("hedges the dirty-commit variant with the agreed wording", () => {
    expect(fixtures.demoInvestigationDirtyCommit.caveat?.kind).toBe("dirty_commit");
    expect(fixtures.demoInvestigationDirtyCommit.caveat?.message).toContain(
      "nearest repository snapshot"
    );
  });

  it("cites file:line@sha in the show-code turn", () => {
    // The sha is demo-marked, so it isn't pure hex — shape is what matters.
    expect(fixtures.demoShowCodeMarkdown).toMatch(/\.ts:\d+(-\d+)?@[0-9a-z]{7}/);
    expect(fixtures.demoShowCodeMarkdown).toContain("```diff");
  });
});

describe("watch fixtures", () => {
  it("validates every spec against the contracts schema", () => {
    for (const watch of fixtures.demoWatches.row) {
      const result = watchSpecSchema.safeParse(watch.spec);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it("derives the chip identity from the spec", () => {
    for (const watch of fixtures.demoWatches.row) {
      expect(watch.identity).toBe(watchIdentity(watch.spec));
    }
  });

  it("covers every watch status and offers cancel only while active", () => {
    const statuses = new Set(fixtures.demoWatches.row.map((watch) => watch.status));
    expect(statuses).toEqual(new Set(["active", "fired", "expired", "cancelled"]));
    for (const watch of fixtures.demoWatches.row) {
      expect(watch.cancellable).toBe(watch.status === "active");
    }
  });

  it("has an expiry narration that admits it could not verify", () => {
    expect(fixtures.demoWatchNarration.expiryUnverified).toContain("couldn't verify");
  });
});

describe("intent fixtures", () => {
  it("validates every intent and marks propose_fix non-executable", () => {
    for (const demoIntent of Object.values(fixtures.demoIntents)) {
      const result = agentIntentSchema.safeParse(demoIntent.intent);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      expect(demoIntent.executable).toBe(demoIntent.intent.kind !== "propose_fix");
    }
  });
});

describe("page context and prompt fixtures", () => {
  it("validates every page context", () => {
    for (const context of Object.values(fixtures.demoPageContexts)) {
      const result = agentPageContextSchema.safeParse(context);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it("covers all four signal kinds", () => {
    const kinds = new Set(fixtures.demoSignalsByPriority.map((signal) => signal.kind));
    expect(kinds).toEqual(
      new Set(["fresh_failure", "waiting_run", "slow_run", "concurrency_saturation"])
    );
  });

  it("validates every chip, stays under the cap, and promotes at most one", () => {
    for (const prompts of Object.values(fixtures.demoPromptSets)) {
      expect(prompts.length).toBeLessThanOrEqual(SUGGESTED_PROMPT_CAP);
      expect(prompts.filter((prompt) => prompt.source === "promoted").length).toBeLessThanOrEqual(
        1
      );
      for (const prompt of prompts) {
        expect(suggestedPromptSchema.safeParse(prompt).success).toBe(true);
      }
    }
  });

  it("drops dismissed chips from the resolved row", () => {
    for (const id of fixtures.demoDismissedPromptIds) {
      expect(fixtures.demoPromptsAfterDismissal.some((prompt) => prompt.id === id)).toBe(false);
    }
  });
});

describe("report fixtures", () => {
  it("covers a healthy and a degraded verdict", () => {
    expect(fixtures.demoHealthyReport.summary.severity).toBe("ok");
    expect(fixtures.demoDegradedReport.summary.severity).toBe("crit");
  });

  it("references only metrics the report carries, and only links it declares", () => {
    for (const vm of Object.values(fixtures.demoReports)) {
      const metricIds = new Set(vm.metrics.map((metric) => metric.id));
      for (const finding of vm.findings) {
        for (const id of finding.metricIds) expect(metricIds.has(id), id).toBe(true);
      }
      const linkKeys = new Set(vm.links.map((link) => link.key));
      for (const entry of vm.footer) {
        if (entry.link) expect(linkKeys.has(entry.link), entry.link).toBe(true);
      }
      expect(vm.footer.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("chart fixtures", () => {
  it("has a row for every configured column", () => {
    const columns = fixtures.demoChart.columns.map((column) => column.name);
    for (const row of fixtures.demoChart.rows) {
      expect(Object.keys(row).sort()).toEqual([...columns].sort());
    }
    expect(columns).toContain(fixtures.demoChart.config.xAxisColumn);
    for (const y of fixtures.demoChart.config.yAxisColumns) expect(columns).toContain(y);
  });
});

describe("demo coverage", () => {
  it("covers every v1 flow", () => {
    const flows = new Set(demoChats.map((chat) => chat.flow));
    expect(flows).toEqual(
      new Set(["investigate", "navigation", "prompts", "watch", "reports", "base"])
    );
  });

  it("covers the base panel states", () => {
    const ids = demoChats.map((chat) => chat.id);
    for (const suffix of [
      "base-streaming",
      "base-tool-in-flight",
      "base-error-retry",
      "base-resumed",
      "base-composer-draft",
      "base-page-context",
    ]) {
      expect(ids).toContain(`${DEMO_ID_PREFIX}${suffix}`);
    }
  });

  it("keeps the draft case an unsent draft over an empty conversation", () => {
    // The first-open prompt panel and the composer draft are the same case: the
    // transcript has to be empty for the panel to show, and the draft has to be
    // there for the case to have a point.
    const draftChat = demoChats.find((chat) => chat.id === `${DEMO_ID_PREFIX}base-composer-draft`);
    expect(draftChat?.draft?.length ?? 0).toBeGreaterThan(0);
    expect(draftChat?.items).toEqual([]);
  });

  it("keeps every chat to one story rather than a variant matrix", () => {
    // Stacked variants of the same thing read as a bug in a conversation; they
    // belong to the state gallery. One banner (the chat's own) and at most one
    // prompt row per chat.
    for (const chat of demoChats) {
      const count = (kind: string) => chat.items.filter((item) => item.kind === kind).length;
      expect(count("banner"), chat.id).toBe(0);
      expect(count("prompts"), chat.id).toBeLessThanOrEqual(1);
    }
  });

  it("answers the page-context question with a real exchange", () => {
    const chat = demoChats.find((c) => c.id === `${DEMO_ID_PREFIX}base-page-context`);
    const messages = (chat?.items ?? []).flatMap((item) =>
      item.kind === "messages" ? item.messages : []
    );
    expect(messages.some((message) => message.role === "user")).toBe(true);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("gives every chat a playbook summary and a natural title", () => {
    for (const chat of demoChats) {
      expect(chat.summary.length, chat.id).toBeGreaterThan(20);
      // Titles read like real chats — identity lives in the demo: id, never the label.
      expect(chat.title.includes("Demo"), chat.title).toBe(false);
      expect(chat.title.length, chat.id).toBeGreaterThan(0);
    }
  });
});

describe("isolation", () => {
  it("imports no server module and no route", () => {
    for (const path of sourceFiles) {
      if (path.endsWith(".server.ts")) continue; // the sanctioned flag file
      const specifiers = importSpecifiers(readFileSync(path, "utf8"));
      for (const specifier of specifiers) {
        expect(specifier.includes(".server"), `${path} -> ${specifier}`).toBe(false);
        expect(/routes?\//.test(specifier), `${path} -> ${specifier}`).toBe(false);
        expect(specifier.includes("~/db"), `${path} -> ${specifier}`).toBe(false);
      }
    }
  });

  it("makes no network calls", () => {
    for (const path of sourceFiles) {
      const source = readFileSync(path, "utf8");
      expect(/\bfetch\s*\(/.test(source), path).toBe(false);
      expect(/\buseFetcher\b/.test(source), path).toBe(false);
    }
  });

  it("keeps the one server file out of the demo module graph", () => {
    for (const path of sourceFiles) {
      if (path.endsWith("demoFlag.server.ts")) continue;
      const specifiers = importSpecifiers(readFileSync(path, "utf8"));
      expect(specifiers.some((specifier) => specifier.includes("demoFlag"))).toBe(false);
    }
  });
});
