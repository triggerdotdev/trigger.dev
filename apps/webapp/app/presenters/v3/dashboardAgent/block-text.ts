/**
 * A view block or a resolved watch as plain text.
 *
 * The panel renders blocks as React; an email, a Slack message, a webhook body or
 * a log line cannot. Rather than each of those re-saying the block's contents in
 * its own words, they render it here. Pure, no React, no request context.
 */
import type { ViewBlock } from "@internal/dashboard-agent-contracts";
import { presentResolvedWatch, watchNoteLine, type WatchResolvedInput } from "./watch-wording";

/** A labelled scalar the check observed. */
export type TextFact = { label: string; value: string };

/** Facts as one `Label: value` line each. */
export function renderFactLines(facts: readonly TextFact[]): string[] {
  return facts.map((fact) => `${fact.label}: ${fact.value}`);
}

function lines(...parts: Array<string | null | undefined | false>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

/**
 * One view block as plain text. Says what the card says and nothing more — no
 * surface may add a sentence of its own on top.
 */
export function renderBlockAsText(block: ViewBlock): string {
  switch (block.type) {
    case "watch_result":
      return lines(block.headline, block.lifetime, block.detail, ...block.followUp);

    case "diagnosis":
      return lines(
        block.summary,
        `Likely cause: ${block.likelyCause}`,
        `Confidence: ${block.confidence}`,
        block.impact ? `Impact: ${block.impact}` : null,
        ...block.evidence.map(
          (item) =>
            `Evidence (${item.type}): ${item.detail}${item.reference ? ` — ${item.reference}` : ""}`
        ),
        ...block.nextSteps.map((step, index) => `${index + 1}. ${step}`)
      );

    case "investigation": {
      const state = block.investigation;
      return lines(
        state.title,
        state.headline,
        `Outcome: ${state.outcome} · severity ${state.severity} · confidence ${state.confidence}`,
        ...state.hypotheses.map(
          (hypothesis) =>
            `${hypothesis.statement} — ${hypothesis.verdict}${
              hypothesis.finding ? `: ${hypothesis.finding}` : ""
            }`
        ),
        state.remediation ? `Fix: ${state.remediation}` : null,
        ...(state.checkNext ?? []).map((step) => `Check next: ${step}`),
        state.caveat ? `Caveat: ${state.caveat.message}` : null
      );
    }

    case "report": {
      const { vm } = block;
      return lines(
        `${vm.title} report for ${vm.scope} (${vm.period}): ${vm.summary.severity}`,
        ...vm.findings.map((finding) => `${finding.type} — ${finding.severity}: ${finding.reason}`)
      );
    }

    // A chart is its shape, not its rows: the rows come from running the query.
    case "chart":
      return lines(`Chart: ${block.title ?? "untitled"} (${block.chartType})`, block.query);

    case "actions":
      return lines(...block.actions.map((action) => `- ${action.label}`));

    default: {
      const unreachable: never = block;
      throw new Error(`Unhandled view block: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * A resolved watch as plain text: the fact, why it was being watched, then what the
 * resolving check saw. What the email body and the Slack message both say.
 */
export function renderResolvedWatchAsText(args: {
  resolved: WatchResolvedInput;
  note: string;
  facts: readonly TextFact[];
}): string {
  const { headline } = presentResolvedWatch(args.resolved);
  return lines(headline, watchNoteLine(args.note), ...renderFactLines(args.facts));
}
