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
import { resolveSuggestedPrompts } from "../suggested-prompts";
import * as fixtures from "./fixtures";
import { DEMO_ID_PREFIX, DEMO_MARKER, demoSourceUri } from "./ids";

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

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g),
    // A side-effect or dynamic import binds nothing, so it never reaches a `from`.
    ...source.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
}

describe("demo ids", () => {
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

  it("rejects a zero source line instead of dropping it", () => {
    expect(() => demoSourceUri("abc", "src/a.ts", 0)).toThrow(/positive integer/);
    expect(demoSourceUri("abc", "src/a.ts", 42)).toContain("?line=42");
    expect(demoSourceUri("abc", "src/a.ts")).not.toContain("line=");
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

  it("points the filtered-runs example at the runs collection, not one run", () => {
    const target = fixtures.demoIntents.navigateToFailedRuns.intent;
    expect(target.kind).toBe("navigate");
    if (target.kind !== "navigate") return;
    const parsed = safeParseTriggerUri(target.target);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.kind).toBe("runs");
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

  it("dismisses a chip the resolver actually emits", () => {
    const full = resolveSuggestedPrompts(fixtures.demoFailedRunPageContext);
    const after = resolveSuggestedPrompts(fixtures.demoFailedRunPageContext, {
      dismissedIds: fixtures.demoResolvedDismissedPromptIds,
    });
    expect(full.map((prompt) => prompt.id)).toContain(fixtures.demoResolvedDismissedPromptIds[0]);
    expect(after.map((prompt) => prompt.id)).not.toEqual(full.map((prompt) => prompt.id));
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
      expect(vm.footer.length).toBeLessThanOrEqual(3);
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

describe("isolation", () => {
  it("reads every form an import can take, including the ones that bind nothing", () => {
    const source = [
      `import { a } from "./a";`,
      `import "~/db.server";`,
      `import type { B } from "./b";`,
      `export * from "./c";`,
      `const d = await import("~/routes/thing");`,
      `import("./lazy").then((m) => m.go());`,
    ].join("\n");

    expect(importSpecifiers(source).sort()).toEqual([
      "./a",
      "./b",
      "./c",
      "./lazy",
      "~/db.server",
      "~/routes/thing",
    ]);
  });

  it("imports no server module and no route", () => {
    for (const path of sourceFiles) {
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

  it("has no server file of its own", () => {
    expect(sourceFiles.filter((path) => path.endsWith(".server.ts"))).toEqual([]);
  });
});
