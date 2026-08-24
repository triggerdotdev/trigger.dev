/**
 * Completed `get_report` tool call to report block.
 *
 * `get_report` returns the whole `ReportViewModel` (the same JSON
 * `GET /api/v1/reports/:key?format=json` serves), and this turns that tool part into
 * a `report` view block, so the card renders the exact snapshot the model was
 * grounded on and the two cannot disagree.
 *
 * Pure and synchronous: no React, no fetch, no clock. Identity comes from the tool
 * call (`id = toolCallId`, `revision = 0`), which makes every report an immutable
 * snapshot: two reports in one conversation never collapse into one card.
 *
 * Every failure mode returns `null` so a malformed or half-streamed part degrades to
 * "no card" rather than to a crash or a card full of blanks.
 */
import {
  VIEW_BLOCK_VERSION,
  isTriggerUri,
  reportBlockSchema,
  type EnvelopedReportBlock,
} from "@internal/dashboard-agent-contracts";

/** The tool whose output this adapter understands. */
export const REPORT_TOOL_PART_TYPE = "tool-get_report";

/** The part shape we read, narrowed by hand — tool parts arrive untyped. */
type MaybeToolPart = {
  type?: unknown;
  state?: unknown;
  toolCallId?: unknown;
  output?: unknown;
};

/** A `get_report` part in any state, including still streaming. */
export function isReportToolPart(part: unknown): boolean {
  return (part as MaybeToolPart | null)?.type === REPORT_TOOL_PART_TYPE;
}

/**
 * Build the block for a completed `get_report` part, or `null` when this part
 * isn't one, hasn't finished, or didn't return a usable view model.
 */
export function reportBlockFromToolPart(part: unknown): EnvelopedReportBlock | null {
  const p = (part ?? {}) as MaybeToolPart;

  if (p.type !== REPORT_TOOL_PART_TYPE) return null;
  // Only a finished call has a snapshot. In-flight states fall back to the pending
  // pill, `output-error` to the generic tool row so the failure stays visible.
  if (p.state !== "output-available") return null;
  // Without the tool call id the block can't be keyed stably across re-renders, so
  // render nothing rather than a card that remounts.
  if (typeof p.toolCallId !== "string" || p.toolCallId.length === 0) return null;

  const output = normalizeOutput(p.output);
  if (!output) return null;

  const parsed = reportBlockSchema.safeParse({
    type: "report",
    id: p.toolCallId,
    revision: 0,
    version: VIEW_BLOCK_VERSION,
    vm: output.vm,
    // Only a grammar-valid URI is carried; an invalid one is dropped rather than
    // failing the whole block, since the card reads fine without it.
    ...(output.uri !== undefined ? { reportUri: output.uri } : {}),
    asOf: asOfFrom(output.vm),
  });

  return parsed.success ? parsed.data : null;
}

// One trust rule for every surface: the shared layout spec owns it.
export { reportIsTrustworthy } from "~/presenters/v3/reports/report-layout";

/**
 * Pull the view model (and an optional source URI) out of whatever `get_report`
 * returned. Tolerates the three shapes a tool output realistically takes: the VM
 * itself, a `{ vm, uri }` wrapper, or a JSON string.
 */
function normalizeOutput(output: unknown): { vm: unknown; uri?: string } | null {
  const value = typeof output === "string" ? tryParseJson(output) : output;

  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;

  // The route's error shape (`{ error: "…" }`) is not a report.
  if (typeof record.error === "string") return null;

  const wrapped = record.vm !== undefined && typeof record.vm === "object";
  const vm = wrapped ? record.vm : record;
  const uri = firstTriggerUri(record.reportUri, record.uri);

  return { vm, ...(uri === undefined ? {} : { uri }) };
}

function firstTriggerUri(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isTriggerUri(candidate)) return candidate;
  }
  return undefined;
}

/** The snapshot's timestamp is the presenter's, never the renderer's clock. */
function asOfFrom(vm: unknown): unknown {
  return (vm as { generatedAt?: unknown } | null)?.generatedAt;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
