/**
 * Completed `get_report` tool call -> report block.
 *
 * The agent doesn't describe a report, it *fetches* one: `get_report` returns the
 * whole `ReportViewModel` (the same JSON `GET /api/v1/reports/:key?format=json`
 * serves). This adapter turns that tool part into a `report` view block so the
 * card renders the EXACT snapshot the model was grounded on — the model never
 * restates a number, so the card and the answer can't disagree.
 *
 * Deliberately pure and synchronous: no React, no fetch, no clock. Identity comes
 * from the tool call (`id = toolCallId`, `revision = 0`), which is what makes
 * every report an immutable historical snapshot — two reports in one conversation
 * have different ids and therefore never collapse into one card.
 *
 * Every failure mode returns `null`. A malformed or half-streamed tool part must
 * degrade to "no card" (the caller then shows the pending pill or the raw tool
 * row), never to a crash or a card full of blanks.
 */
import {
  VIEW_BLOCK_VERSION,
  isTriggerUri,
  reportBlockSchema,
  type EnvelopedReportBlock,
  type ReportViewModelPayload,
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
  // Only a finished call has a snapshot. The in-flight states fall back to the
  // pending pill, `output-error` to the generic tool row so the failure is visible.
  if (p.state !== "output-available") return null;
  // Identity is the tool call's. Without it the block couldn't be keyed stably
  // across re-renders, so we'd rather render nothing than a card that remounts.
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

/**
 * `facts.trustworthy === false` means the telemetry behind the verdict is stale,
 * so the numbers are informational only. Absent = trustworthy (the common case,
 * and what pre-`facts` snapshots imply).
 */
export function reportIsTrustworthy(vm: Pick<ReportViewModelPayload, "facts">): boolean {
  return vm.facts?.trustworthy !== false;
}

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
