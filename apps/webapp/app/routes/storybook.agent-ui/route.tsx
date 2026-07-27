import { VIEW_BLOCK_VERSION } from "@internal/dashboard-agent-contracts";
import type { DiagnosisBlock, ViewBlock } from "@internal/dashboard-agent";
import { ViewBlocks } from "~/components/dashboard-agent/view-catalog";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

// Storybook for the dashboard agent's view catalog — the blocks the agent emits
// via its render_view tool. Each example is a real block spec rendered through
// the same ViewBlocks registry the chat panel uses, at roughly panel width.

const fullDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: "run_a1b2c3d4e5",
  summary:
    "The run failed because processOrder threw on an order with no line items. The payload had an empty items array.",
  category: "user_code_error",
  likelyCause:
    "processOrder calls order.items[0] without checking length, so an empty items array throws a TypeError before any work happens.",
  confidence: "high",
  evidence: [
    {
      type: "error",
      detail: "TypeError: Cannot read properties of undefined (reading 'sku')",
      reference: "run_a1b2c3d4e5",
    },
    { type: "failed_span", detail: "processOrder attempt 1 failed after 42ms" },
    {
      type: "source",
      detail: "The throwing line reads order.items[0].sku with no guard.",
      reference: "src/trigger/processOrder.ts:18",
    },
    {
      type: "historical_match",
      detail: "14 runs of this task hit the same error in the last 24h.",
      reference: "error_emptyorder",
    },
  ],
  impact:
    "14 runs of process-order failed with this error in the last 24 hours, all in production.",
  nextSteps: [
    "Guard against an empty items array at the top of processOrder and return early.",
    "Validate the payload before triggering so empty orders never reach the task.",
  ],
  actions: [
    { label: "View run", kind: "view_run", target: "run_a1b2c3d4e5" },
    { label: "Retries docs", kind: "docs", target: "https://trigger.dev/docs/errors-retrying" },
  ],
};

const externalServiceDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: "run_f6g7h8i9j0",
  summary: "chargePayment timed out waiting on the Stripe API after 30 seconds.",
  category: "external_service",
  likelyCause:
    "The Stripe call has no timeout or retry, so a slow upstream response runs past the task's max duration.",
  confidence: "medium",
  evidence: [
    {
      type: "error",
      detail: "TimeoutError: Stripe API timed out after 30s",
      reference: "run_f6g7h8i9j0",
    },
    { type: "deploy", detail: "First seen on version 20260620.2", reference: "20260620.2" },
  ],
  impact: "Intermittent: 3 of the last 50 charge-payment runs timed out.",
  nextSteps: [
    "Wrap the Stripe call in a retry with backoff.",
    "Set an explicit request timeout shorter than the task's max duration.",
  ],
  actions: [{ label: "View run", kind: "view_run", target: "run_f6g7h8i9j0" }],
};

const lowConfidenceDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: "run_k1l2m3n4o5",
  summary:
    "The run crashed without a captured error, so the cause isn't conclusive from the available signals.",
  category: "unknown",
  likelyCause:
    "The container exited without writing an error. This is consistent with an out-of-memory kill, but there's no OOM signal in the trace to confirm it.",
  confidence: "low",
  evidence: [
    { type: "failed_span", detail: "Root span ended with status CRASHED and no error payload." },
    { type: "logs", detail: "Logs stop abruptly mid-execution with no stack trace." },
  ],
  nextSteps: [
    "Re-run with a larger machine to rule out out-of-memory.",
    "Add logging around the last successful step to narrow where it stops.",
  ],
};

// Blocks may carry an envelope: `id` identifies the block across turns and
// `revision` says how fresh it is. ViewBlocks collapses same-(type, id) blocks
// to the highest revision, so a re-emitted diagnosis replaces the earlier one
// instead of stacking cards.
const revisedDiagnosis: ViewBlock[] = [
  {
    ...lowConfidenceDiagnosis,
    id: "diagnosis-run_a1b2c3d4e5",
    revision: 1,
    version: VIEW_BLOCK_VERSION,
    summary: "Revision 1 — first guess, before the logs came back. Should not render.",
  },
  {
    ...externalServiceDiagnosis,
    id: "diagnosis-run_a1b2c3d4e5",
    revision: 2,
    version: VIEW_BLOCK_VERSION,
    summary: "Revision 2 — narrowed to the payload, still unconfirmed. Should not render.",
  },
  {
    ...fullDiagnosis,
    id: "diagnosis-run_a1b2c3d4e5",
    revision: 3,
    version: VIEW_BLOCK_VERSION,
    summary:
      "Revision 3 — the only card that should render: processOrder threw on an order with no line items.",
  },
];

// Two envelope-less (legacy) blocks: no id, so nothing is grouped and both
// render, in order — the pre-envelope behaviour.
const legacyBlocks: ViewBlock[] = [externalServiceDiagnosis, lowConfidenceDiagnosis];

function Example({ title, note, blocks }: { title: string; note?: string; blocks: ViewBlock[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Header2>{title}</Header2>
      {note ? <Paragraph variant="extra-small">{note}</Paragraph> : null}
      <div className="w-104 max-w-full">
        <ViewBlocks blocks={blocks} />
      </div>
    </div>
  );
}

export default function Story() {
  return (
    <div className="flex flex-col gap-8 p-6">
      <div className="flex flex-col gap-1">
        <Header1>Dashboard agent UI</Header1>
        <Paragraph variant="small">
          Blocks the dashboard agent renders via its render_view tool, shown through the same
          ViewBlocks registry the chat panel uses. The catalog has the diagnosis (failure) card,
          shown here, and a chart block that runs a TRQL query live (only renders inside a
          project/env, so it's not shown here). Run links resolve inside a project; here they render
          as plain text.
        </Paragraph>
      </div>

      <div className="flex flex-wrap gap-8">
        <Example title="Diagnosis — full, high confidence" blocks={[fullDiagnosis]} />
        <Example title="Diagnosis — external service, medium" blocks={[externalServiceDiagnosis]} />
        <Example title="Diagnosis — low confidence, minimal" blocks={[lowConfidenceDiagnosis]} />
        <Example
          title="Envelope — three revisions, one card"
          note="Three blocks share (diagnosis, diagnosis-run_a1b2c3d4e5) at revisions 1–3. Only revision 3 renders."
          blocks={revisedDiagnosis}
        />
        <Example
          title="Legacy — no envelope, both render"
          note="Blocks with no id are never grouped: both render, in order."
          blocks={legacyBlocks}
        />
      </div>
    </div>
  );
}
