import type { EnvelopedViewBlock } from "@internal/dashboard-agent-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { ViewBlocks } from "./view-catalog";

/**
 * `dropWatch`/`withoutWatchActions` withhold a watch button by prop, not by unmounting a
 * component: only rendered markup proves the button itself is gone when the flag is off.
 */
function markup(blocks: EnvelopedViewBlock[], watchEnabled: boolean) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(ViewBlocks, { blocks, onIntent: () => {}, watchEnabled })
      )
    )
  );
}

const watchAction = {
  label: "Set up a watch",
  intent: {
    kind: "watch" as const,
    spec: {
      kind: "error_recurrence" as const,
      fingerprint: "a1b2c3",
      checkEveryMinutes: 15,
      maxHours: 6,
      note: "the TypeError in send-order-receipt",
    },
  },
};

const askAction = {
  label: "Investigate it",
  intent: { kind: "ask" as const, prompt: "Investigate the send-order-receipt failures." },
};

describe("ActionsBlock's watch action", () => {
  const block: EnvelopedViewBlock = {
    id: "actions-1",
    revision: 0,
    version: 1,
    type: "actions",
    actions: [watchAction, askAction],
  };

  it("is dropped while watch functionality is disabled", () => {
    const html = markup([block], false);
    expect(html).not.toContain("Set up a watch");
    expect(html).toContain("Investigate it");
  });

  it("renders once watch functionality is enabled", () => {
    const html = markup([block], true);
    expect(html).toContain("Set up a watch");
  });
});

describe("InvestigationCard's capability watch action", () => {
  const block: EnvelopedViewBlock = {
    id: "investigation-1",
    revision: 0,
    version: 1,
    type: "investigation",
    investigation: {
      outcome: "concluded",
      severity: "crit",
      confidence: "high",
      title: "send-order-receipt fails on every retry",
      headline: "Every attempt dies on a null order id.",
      remediation: "Guard the receipt builder against a missing order.",
      hypotheses: [],
      evidence: [],
    },
    capabilities: {
      version: 1,
      actions: [{ kind: "watch", label: "Watch for a repeat", intent: watchAction.intent }],
    },
  };

  it("is dropped while watch functionality is disabled", () => {
    const html = markup([block], false);
    expect(html).not.toContain("Watch for a repeat");
  });

  it("renders once watch functionality is enabled", () => {
    const html = markup([block], true);
    expect(html).toContain("Watch for a repeat");
  });
});

describe("ReportView's recovery-watch footer action", () => {
  const block: EnvelopedViewBlock = {
    id: "report-1",
    revision: 0,
    version: 1,
    type: "report",
    asOf: "2026-01-01T00:00:00.000Z",
    vm: {
      title: "health",
      scope: "environment",
      period: "24h",
      generatedAt: "2026-01-01T00:00:00.000Z",
      windowMinutes: 1440,
      summary: { severity: "warn", statements: [] },
      findings: [],
      metrics: [],
      facts: {},
      links: [],
      footer: [],
    },
  };

  it("is dropped while watch functionality is disabled", () => {
    const html = markup([block], false);
    expect(html).not.toContain("Watch…");
  });

  it("renders once watch functionality is enabled", () => {
    const html = markup([block], true);
    expect(html).toContain("Watch…");
  });
});
