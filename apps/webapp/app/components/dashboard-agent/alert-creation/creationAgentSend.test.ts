import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  pendingDraftPatches,
  applyDraftPatch,
  alertDraftPatchSchema,
  creationChatToReuse,
  creationTurnClientData,
  rescopeTurnClientData,
  type ToolResultPayload,
} from "./draftPatch";
import { alertCreationDraftSchema } from "@internal/dashboard-agent-contracts";
import { sanitizeDetail } from "./useCreationAgentSend";
import type { FlowAnswers } from "./flow-state";

const panelSource = readFileSync(new URL("../DashboardAgentPanel.tsx", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("../DashboardAgentChat.tsx", import.meta.url), "utf8");

const STREAM_FIXTURE_OK = [
  {
    id: "msg_001",
    parts: [
      { type: "text", text: "I'll set that up for you." },
      {
        type: "tool-update_alert_draft",
        state: "output-available",
        toolCallId: "call_abc",
        output: {
          ok: true,
          patch: {
            area: "queues",
            what: "queue.depth",
            scope: { type: "all" },
            condition: { value: 100, windowSec: 600, params: { cpuThreshold: 90 } },
          },
          reason: "Set queue depth threshold to 100 over 10 minutes.",
        } satisfies ToolResultPayload,
      },
    ],
  },
];

const STREAM_FIXTURE_FAIL = [
  {
    id: "msg_002",
    parts: [
      {
        type: "tool-update_alert_draft",
        state: "output-available",
        toolCallId: "call_def",
        output: {
          ok: false,
          errors: ["Invalid scope type"],
        } satisfies ToolResultPayload,
      },
    ],
  },
];

describe("pendingDraftPatches from streamed tool parts", () => {
  it("extracts a patch from a streamed assistant message", () => {
    const seen = new Set<string>();
    const results = pendingDraftPatches(STREAM_FIXTURE_OK, seen);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.patch?.area).toBe("queues");
    expect(results[0]!.reason).toContain("queue depth");
  });

  it("applies the extracted patch to flow answers", () => {
    const seen = new Set<string>();
    const results = pendingDraftPatches(STREAM_FIXTURE_OK, seen);
    const patch = alertDraftPatchSchema.parse(results[0]!.patch);
    const base: FlowAnswers = {};
    const patched = applyDraftPatch(base, patch);
    expect(patched.area).toBe("queues");
    expect(patched.what).toBe("queue.depth");
    expect(patched.scope).toBe("all");
    expect(patched.condition).toBe("100");
    expect(patched.windowMinutes).toBe(10);
    expect(patched.conditionParams).toEqual({ cpuThreshold: 90 });
  });

  it("deduplicates by toolCallId", () => {
    const seen = new Set<string>();
    pendingDraftPatches(STREAM_FIXTURE_OK, seen);
    const second = pendingDraftPatches(STREAM_FIXTURE_OK, seen);
    expect(second).toHaveLength(0);
  });

  it("extracts ok:false results", () => {
    const seen = new Set<string>();
    const results = pendingDraftPatches(STREAM_FIXTURE_FAIL, seen);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.errors).toContain("Invalid scope type");
  });

  it("ignores parts without output-available state", () => {
    const seen = new Set<string>();
    const results = pendingDraftPatches(
      [
        {
          id: "msg_003",
          parts: [
            {
              type: "tool-update_alert_draft",
              state: "pending",
              toolCallId: "call_ghi",
              output: { ok: true, patch: { area: "runs" } },
            },
          ],
        },
      ],
      seen
    );
    expect(results).toHaveLength(0);
  });

  it("fails when the response is parsed as JSON instead of a stream", () => {
    expect(panelSource).not.toMatch(/executeSend/);
    expect(panelSource).toMatch(/onFreeText={sendCreationText}/);
    expect(panelSource).toMatch(/openChat\(chatId, true\)/);

    expect(chatSource).toMatch(/pendingDraftPatches/);
    expect(chatSource).toMatch(/onAlertDraftPatch/);
  });
});

describe("panel wiring for streamed draft patches", () => {
  it("DashboardAgentChat receives onAlertDraftPatch callback in creation mode", () => {
    expect(panelSource).toMatch(
      /onAlertDraftPatch={inCreationMode\s*\?\s*creationCallbacks\.onAlertDraftPatch/
    );
  });

  it("DashboardAgentChat renders no DOM in creation mode (headless)", () => {
    expect(panelSource).toMatch(/headless={inCreationMode \|\| inEditMode}/);
    expect(chatSource).toMatch(/if\s*\(headless\)\s*return\s+null/);
    expect(panelSource).not.toMatch(/sr-only/);
  });

  it("fails when a text-only reply is not rendered in the visible creation transcript", () => {
    expect(chatSource).toMatch(/onCreationTextReply/);
    expect(chatSource).toMatch(/onCreationTextReply\(text\)/);

    expect(panelSource).toMatch(
      /onCreationTextReply={inCreationMode\s*\?\s*creationCallbacks\.onCreationTextReply/
    );
    expect(panelSource).toMatch(/systemLines={creationAgentSend\.systemLines}/);
  });

  it("fails when an intermediate ok:false result is rendered before the turn settles", () => {
    expect(chatSource).toMatch(/draftPatchAccRef/);
    expect(chatSource).not.toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?onAlertDraftPatch\(results\)[\s\S]*?\},\s*\[messages/
    );
    expect(chatSource).toMatch(/pendingPatches\.length\s*>\s*0\s*&&\s*onAlertDraftPatch/);
  });
});

describe("error sanitization", () => {
  it("truncates long server messages", () => {
    const long = "x".repeat(200);
    const result = sanitizeDetail(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toMatch(/…$/);
  });

  it("strips newlines from server messages", () => {
    expect(sanitizeDetail("line1\nline2\r\nline3")).toBe("line1 line2 line3");
  });
});

describe("single visible panel instance", () => {
  it("panel root has a unique data attribute for reliable querying", () => {
    expect(panelSource).toMatch(/data-agent-panel="visible"/);
  });

  it("DashboardAgent mounts exactly one DashboardAgentPanel", () => {
    const agentSource = readFileSync(new URL("../DashboardAgent.tsx", import.meta.url), "utf8");
    const mounts = agentSource.match(/<DashboardAgentPanel\b/g);
    expect(mounts).toHaveLength(1);
  });

  it("system lines route to the visible CreationTranscript, not the headless chat", () => {
    expect(panelSource).toMatch(/systemLines={creationAgentSend\.systemLines}/);
    expect(panelSource).toMatch(/headless={inCreationMode \|\| inEditMode}/);
    expect(chatSource).toMatch(/if\s*\(headless\)\s*return\s+null/);
  });
});

describe("creation mode entry", () => {
  it("fails when openSource='alerts' does not render the creation shell", () => {
    expect(panelSource).toMatch(/creationModeRef\.current[\s\S]*?setLoading\(false\)/);
    expect(panelSource).toMatch(/\{inCreationMode \? \([\s\S]*?CreationChatShell/);
  });
});

describe("creation session tool scope", () => {
  it("fails when the creation session scope includes create_monitoring_alert", () => {
    const base = { userId: "user_1", organizationId: "org_1" };
    expect(creationTurnClientData(base, {}).toolScope).toBe("alert_creation");
    expect(panelSource).not.toMatch(/toolScope:\s*["']create_monitoring_alert["']/);
  });

  // Mutation: dropping alertDraft from creationTurnClientData fails this.
  it("sends the draft answers with every creation turn", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: "emails",
      condition: "250",
      windowMinutes: 10,
      notifiers: ["chat"],
      expiry: "37h",
    };
    const data = creationTurnClientData({ userId: "user_1", organizationId: "org_1" }, answers);
    expect(data).toMatchObject({ userId: "user_1", toolScope: "alert_creation" });
    expect(alertCreationDraftSchema.parse(data.alertDraft)).toEqual({
      capabilityKey: "queue.depth",
      answers,
    });
    expect(panelSource).toMatch(
      /clientData={inCreationMode \? creationClientData : activeChatClientData}/
    );
  });

  // Mutation: dropping the seq check reuses the previous session's chat.
  it("a new creation session starts a new chat", () => {
    const session = { seq: 1, chatId: "chat_old" };
    expect(creationChatToReuse(session, 1, "chat_old")).toBe("chat_old");
    expect(creationChatToReuse(session, 2, "chat_old")).toBeUndefined();
    expect(creationChatToReuse(session, 1, "chat_other")).toBeUndefined();
    expect(panelSource).toMatch(
      /creationChatToReuse\(creationAgentChat\.current, creationEntrySeq/
    );
  });

  // Mutation: replaying the deferred create with plain clientData drops the scope.
  it("a deferred create keeps the creation scope and draft", () => {
    const deferred = creationTurnClientData({ userId: "u", organizationId: "o" }, { area: "runs" });
    const replayed = rescopeTurnClientData(
      { userId: "u", organizationId: "o", currentPage: "/new" },
      deferred
    );
    expect(replayed).toMatchObject({
      currentPage: "/new",
      toolScope: "alert_creation",
      alertDraft: { answers: { area: "runs" } },
    });
    expect(rescopeTurnClientData({ userId: "u" }, undefined)).toBeUndefined();
    expect(panelSource).toMatch(
      /rescopeTurnClientData\(clientData, pendingCreate\.turnClientData\)/
    );
  });
});
