import {
  forceSettledInvestigationState,
  investigationStateSchema,
  VIEW_BLOCK_VERSION,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import {
  investigationSettlementMessage,
  investigationSettlementMessageId,
} from "@internal/dashboard-agent-db";
import { describe, expect, it } from "vitest";
import { liveInvestigation } from "~/components/dashboard-agent/progress-line";

/**
 * The card the sweep appends is what stops the panel's spinner: the panel resolves the
 * investigation from the chat's own `render_view` parts, never from the settled row.
 */

const INVESTIGATION_ID = "inv_settlement_card";

function openState(): InvestigationState {
  return investigationStateSchema.parse({
    outcome: "in_progress",
    severity: "warn",
    confidence: "medium",
    title: "send-order-receipt keeps failing",
    headline: "Checking whether the failures share a payload.",
    progress: "Reading the run's spans",
    hypotheses: [
      {
        id: "h1",
        statement: "The new payload dropped a field the task reads.",
        verdict: "testing",
        evidence: [],
      },
    ],
    evidence: [],
  });
}

function openCardMessage(state: InvestigationState) {
  return {
    id: "msg_open",
    role: "assistant",
    parts: [
      {
        type: "tool-render_view",
        toolCallId: "tc_open",
        state: "output-available",
        input: { blocks: [{ type: "investigation", investigation: state }] },
        output: {
          blocks: [
            {
              type: "investigation",
              investigation: state,
              id: INVESTIGATION_ID,
              revision: 0,
              version: VIEW_BLOCK_VERSION,
            },
          ],
        },
      },
    ],
  };
}

describe("the investigation settlement card", () => {
  it("ends the panel's spinner once appended to the transcript", () => {
    const open = openState();
    const message = investigationSettlementMessage({
      investigationId: INVESTIGATION_ID,
      revision: 1,
      state: forceSettledInvestigationState(open),
    });

    expect(message).not.toBeNull();
    expect(message!.id).toBe(investigationSettlementMessageId(INVESTIGATION_ID, 1));

    const transcript = [openCardMessage(open)];
    expect(liveInvestigation(transcript)).toEqual({ progress: "Reading the run's spans" });
    expect(liveInvestigation([...transcript, message as never])).toBeNull();
  });
});
