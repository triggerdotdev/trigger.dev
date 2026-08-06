import {
  investigationSettlementMessageId,
  type Investigation,
  type InvestigationCardMessage,
} from "@internal/dashboard-agent-db";
import {
  forceSettledInvestigationState,
  investigationStateSchema,
  UNSETTLED_INVESTIGATION_NOTE,
  VIEW_BLOCK_VERSION,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import { describe, expect, it, vi } from "vitest";
import { liveInvestigation } from "~/components/dashboard-agent/progress-line";

// The sweep's own datastore is never reached here: every write is injected. The
// connection is only stubbed so importing the service doesn't open a pool.
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: undefined }));

const { sweepDashboardAgentInvestigations } =
  await import("~/services/dashboardAgentInvestigationSweep.server");

/**
 * The transcript half of the sweep, without a container: settling the row is invisible
 * to the panel, which resolves a card from the chat's own `render_view` parts.
 *
 * The database half — that the closing card actually lands in `chats.messages` — is
 * covered by `dashboardAgentInvestigationSweep.test.ts`, which needs Postgres.
 */

const CHAT_ID = "chat_sweep_card";
const INVESTIGATION_ID = "inv_sweep_card";

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

/** The card the agent left behind, as the transcript holds it. */
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

function staleRow(state: InvestigationState): Investigation {
  return {
    id: INVESTIGATION_ID,
    chatId: CHAT_ID,
    projectRef: "proj_sweep",
    environmentRef: "env_sweep",
    revision: 0,
    state,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Investigation;
}

/**
 * Stands in for the datastore: the conditional settle (`in_progress` only, mirroring
 * `forceSettledInvestigationState`) and the id-deduped append.
 */
function fakeStore(initial: InvestigationState) {
  const row = { revision: 0, state: initial };
  const appended: InvestigationCardMessage[] = [];
  return {
    row,
    appended,
    settle: async (params: { id: string; note: string }) => {
      if (investigationStateSchema.parse(row.state).outcome !== "in_progress") return null;
      row.state = forceSettledInvestigationState(investigationStateSchema.parse(row.state));
      row.revision += 1;
      return { id: params.id, revision: row.revision, state: row.state };
    },
    closeCard: async (params: { chatId: string; message: InvestigationCardMessage }) => {
      if (appended.some((message) => message.id === params.message.id)) return false;
      appended.push(params.message);
      return true;
    },
  };
}

describe("the dashboard agent investigation sweep's closing card", () => {
  it("appends the terminal card to the chat, so the panel stops spinning", async () => {
    const open = openState();
    const store = fakeStore(open);

    const result = await sweepDashboardAgentInvestigations({
      listStale: async () => [staleRow(open)],
      settle: store.settle,
      closeCard: store.closeCard,
    });

    expect(store.appended).toHaveLength(1);
    expect(result).toMatchObject({ stale: 1, settled: 1, closed: 1, alreadySettled: 0, failed: 0 });

    const message = store.appended[0]!;
    expect(message.id).toBe(investigationSettlementMessageId(INVESTIGATION_ID, 1));
    expect(message.role).toBe("assistant");

    const part = message.parts[0] as {
      type: string;
      state: string;
      output: { blocks: Record<string, any>[] };
    };
    expect(part.type).toBe("tool-render_view");
    expect(part.state).toBe("output-available");
    expect(part.output.blocks[0]).toMatchObject({
      type: "investigation",
      id: INVESTIGATION_ID,
      revision: 1,
      version: VIEW_BLOCK_VERSION,
    });
    const settled = part.output.blocks[0]!.investigation;
    expect(settled.outcome).toBe("inconclusive");
    expect(settled.confidence).toBe("low");
    expect(settled.progress).toBeUndefined();
    expect(settled.headline).toContain(UNSETTLED_INVESTIGATION_NOTE);
    // What was checked survives: the card closes honestly, it doesn't get blanked.
    expect(settled.hypotheses).toHaveLength(1);

    // The panel, over the transcript a refresh loads: the spinner was there, and the
    // appended revision is what ends it.
    const transcript = [openCardMessage(open)];
    expect(liveInvestigation(transcript)).toEqual({ progress: "Reading the run's spans" });
    expect(liveInvestigation([...transcript, message as never])).toBeNull();
  });

  it("a retried run neither duplicates the card nor opens a second investigation", async () => {
    const open = openState();
    const store = fakeStore(open);
    const deps = {
      listStale: async () => [staleRow(open)],
      settle: store.settle,
      closeCard: store.closeCard,
    };

    await sweepDashboardAgentInvestigations(deps);
    const second = await sweepDashboardAgentInvestigations(deps);

    expect(store.appended.map((message) => message.id)).toEqual([
      investigationSettlementMessageId(INVESTIGATION_ID, 1),
    ]);
    expect(second).toMatchObject({ stale: 1, settled: 0, closed: 0, alreadySettled: 1, failed: 0 });
    expect(store.row.revision).toBe(1);
  });
});
