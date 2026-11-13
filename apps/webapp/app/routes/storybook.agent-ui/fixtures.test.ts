import { safeParseStoredViewBlock, viewBlockSchema } from "@internal/dashboard-agent-contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_MARKER } from "~/components/dashboard-agent/demo/ids";
import { planDiagnosisActions } from "~/components/dashboard-agent/diagnosis-actions";
import { renderableActions } from "~/components/dashboard-agent/view-actions";
import { reportTrust } from "~/presenters/v3/reports/report-layout";
import {
  externalServiceDiagnosis,
  fullDiagnosis,
  lowConfidenceDiagnosis,
  offerActionsBlock,
  revisedDiagnosisBlocks,
  untrustworthyReport,
} from "./fixtures";

/**
 * The gallery's hand-written fixtures, checked against the code that reads them rather
 * than against themselves. A fixture that still typechecks but no longer matches what
 * the product emits would otherwise render a state nobody can reach.
 */

describe("gallery view blocks", () => {
  it("parses every enveloped block through the schema the product persists with", () => {
    for (const block of [...revisedDiagnosisBlocks, offerActionsBlock]) {
      const result = viewBlockSchema.safeParse(block);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it("parses the envelope-less diagnoses through the stored-block schema", () => {
    for (const block of [fullDiagnosis, externalServiceDiagnosis, lowConfidenceDiagnosis]) {
      const result = safeParseStoredViewBlock(block);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it("offers only actions the panel would render", () => {
    expect(renderableActions(offerActionsBlock.actions)).toHaveLength(
      offerActionsBlock.actions.length
    );
  });

  /**
   * The gallery renders outside a project route, so the card resolves no run path and drops
   * the button. With a resolver both survive: the fixture's actions are still ones the card
   * can plan, not ones it silently discards.
   */
  it("plans every diagnosis action once its destination resolves", () => {
    const planned = planDiagnosisActions(fullDiagnosis.actions ?? [], {
      runPath: (runId) => `/runs/${runId}`,
      docsUrl: (target) => target,
    });
    expect(planned.map((action) => action.kind)).toEqual(["view_run", "docs"]);
  });
});

/**
 * `demo.test.ts` marks the demo layer's ids. These fixtures are hand-written next to the
 * route, so the same rule is asserted here: a `view_run` or `navigate` the presenter can
 * resolve must land on demo data, never on somebody's environment.
 */
describe("gallery identifiers", () => {
  // The digit keeps discriminants like `error_recurrence` out; ids always carry one.
  const IDENTIFIER = /^(run|error|watch|queue|proj|env|deployment)_[a-z0-9]*\d|^trigger:\/\//i;

  function strings(value: unknown, path = "fixture"): Array<[string, string]> {
    if (typeof value === "string") return [[value, path]];
    if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
    if (value && typeof value === "object") {
      return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
    }
    return [];
  }

  const fixtures = {
    fullDiagnosis,
    externalServiceDiagnosis,
    lowConfidenceDiagnosis,
    revisedDiagnosisBlocks,
    offerActionsBlock,
    untrustworthyReport,
  };

  it("names no resource that isn't demo data", () => {
    for (const [value, path] of strings(fixtures)) {
      if (!IDENTIFIER.test(value)) continue;
      expect(value, path).toContain(DEMO_MARKER);
    }
  });
});

describe("gallery report", () => {
  it("names an untrustworthy reason the card has a caveat for", () => {
    const trust = reportTrust(untrustworthyReport);
    expect(trust?.badge).toBe("stale data");
  });
});

/**
 * `demo/index.ts` re-exports `DemoChartCard` and `DemoIntentBubble`, so importing it here would
 * pull React components into a suite that runs without a DOM. `demo.test.ts` reaches past the
 * barrel for the same reason; these fixtures and their test do too.
 *
 * Structural: what a module drags in is not observable from inside it.
 */
describe("the gallery fixtures stay out of the demo barrel", () => {
  const BARREL = /from "~\/components\/dashboard-agent\/demo"/;

  for (const file of ["fixtures.ts", "fixtures.test.ts"]) {
    it(`${file} reaches past it`, () => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(BARREL.test(source), `${file} imports the demo barrel`).toBe(false);
      expect(source).toContain('"~/components/dashboard-agent/demo/');
    });
  }
});
