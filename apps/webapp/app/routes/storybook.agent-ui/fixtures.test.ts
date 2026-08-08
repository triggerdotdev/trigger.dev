import {
  safeParseStoredViewBlock,
  viewBlockSchema,
  watchExternalNotificationLine,
} from "@internal/dashboard-agent-contracts";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it } from "vitest";
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
  watchConfirmationBlock,
  watchDegradedConfirmationBlock,
  watchSatisfiedBlock,
} from "./fixtures";

/**
 * The gallery's hand-written fixtures, checked against the code that reads them rather
 * than against themselves. A fixture that still typechecks but no longer matches what
 * the product emits would otherwise render a state nobody can reach.
 */

describe("gallery view blocks", () => {
  it("parses every enveloped block through the schema the product persists with", () => {
    for (const block of [
      ...revisedDiagnosisBlocks,
      offerActionsBlock,
      watchConfirmationBlock,
      watchDegradedConfirmationBlock,
      watchSatisfiedBlock,
    ]) {
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

  /** Every stored spec is normalized, so an unprefixed fingerprint is a shape no card sees. */
  it("cites error fingerprints in the normalized form the watch service stores", () => {
    for (const action of offerActionsBlock.actions) {
      if (action.intent.kind !== "watch" || action.intent.spec.kind !== "error_recurrence")
        continue;
      const { fingerprint } = action.intent.spec;
      expect(fingerprint).toBe(ErrorId.toId(fingerprint));
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

describe("gallery watch confirmations", () => {
  it("states the external outcome each confirmation claims", () => {
    expect(watchConfirmationBlock.followUp).toContain(
      watchExternalNotificationLine({ status: "enabled" })
    );
    expect(watchDegradedConfirmationBlock.followUp).toContain(
      watchExternalNotificationLine({
        status: "unavailable",
        reason: "email_alerts_not_configured",
      })
    );
  });

  it("says the first check could not run on the degraded one, and not on the other", () => {
    expect(watchDegradedConfirmationBlock.detail).toBeTruthy();
    expect(watchConfirmationBlock.detail).toBeNull();
  });
});

describe("gallery report", () => {
  it("names an untrustworthy reason the card has a caveat for", () => {
    const trust = reportTrust(untrustworthyReport);
    expect(trust?.badge).toBe("stale data");
  });
});
