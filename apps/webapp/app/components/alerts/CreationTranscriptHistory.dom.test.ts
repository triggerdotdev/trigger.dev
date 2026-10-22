// @vitest-environment jsdom
import type { UIMessage } from "@ai-sdk/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentTurns } from "~/components/dashboard-agent/DashboardAgentMessages";
import type { ToolResultPayload } from "~/components/dashboard-agent/alert-creation/draftPatch";
import { draftResultLines } from "~/components/dashboard-agent/alert-creation/useCreationAgentSend";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  alertName,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import {
  alertCreatedMessage,
  alertCreationOpeningMessage,
  answersFromCreateRequest,
  createdCardFields,
} from "./alertCreatedCard";
import { CreationTranscript, type SystemLine } from "./CreationTranscript";

vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => undefined }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => undefined }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => undefined }));

const noop = () => {};

function wrap(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, el)
    )
  );
}

function texts(html: string, selector?: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  const root = selector ? host.querySelector(selector)! : host;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  while (walker.nextNode()) {
    const value = walker.currentNode.textContent?.trim();
    if (value) out.push(value);
  }
  return out;
}

const CHANNELS = [{ id: "ch_1", name: "Ops webhook", type: "WEBHOOK" }];

const ANSWERS: FlowAnswers = {
  area: "queues",
  what: "queue.depth",
  scope: "all",
  condition: "100",
  windowMinutes: 5,
  notifiers: ["chat", "ch_1"],
  expiry: "24h",
};

const REQUEST = {
  chatNotifier: "on" as const,
  expiry: "24h",
  form: {
    capabilityKey: "queue.depth",
    scopeType: "all",
    conditionKind: "threshold",
    value: 100,
    windowMinutes: 5,
    notifierChannelIds: ["ch_1"],
  },
};

const DRAFT_RESULT: ToolResultPayload = {
  ok: true,
  patch: { what: "queue.depth" },
  reason: "Watching queue depth.",
};

function makeFlow(overrides: Partial<CreationFlowState>): CreationFlowState {
  return {
    answers: ANSWERS,
    currentStep: undefined,
    completedSteps: [],
    isReview: false,
    created: true,
    createdAlertId: "alert_1",
    submitting: false,
    submitError: false,
    selectChip: noop,
    setCondition: noop,
    setConditionParams: noop,
    confirmCondition: noop,
    setScopeValue: noop,
    setWindowMinutes: noop,
    toggleNotifier: noop,
    confirmNotifiers: noop,
    setExpiry: noop,
    create: noop,
    reset: noop,
    patchAnswers: noop,
    ...overrides,
  };
}

function historyTexts(messages: unknown[]) {
  return texts(
    wrap(
      createElement(DashboardAgentTurns, {
        messages: messages as UIMessage[],
        activity: null,
      })
    )
  );
}

describe("alert creation transcript after reload", () => {
  it("reads like the live session: bubbles, tool lines and card rows", () => {
    const systemLines: SystemLine[] = [
      { id: "l1", text: "watch queue depth", variant: "user" },
      ...draftResultLines(DRAFT_RESULT).map((line, i) => ({ id: `d${i}`, ...line })),
      { id: "l2", text: "Done, check below.", variant: "reply" },
    ];
    const live = texts(
      wrap(
        createElement(CreationTranscript, {
          flow: makeFlow({}),
          channels: CHANNELS,
          systemLines,
        })
      ),
      '[data-testid="creation-flow"]'
    );

    const fields = createdCardFields(
      answersFromCreateRequest(REQUEST),
      CHANNELS,
      alertName(ANSWERS)
    );
    const stored = historyTexts([
      alertCreationOpeningMessage("chat_1"),
      { id: "u1", role: "user", parts: [{ type: "text", text: "watch queue depth" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-update_alert_draft",
            toolCallId: "call_1",
            state: "output-available",
            input: {},
            output: DRAFT_RESULT,
          },
          { type: "text", text: "Done, check below." },
        ],
      },
      alertCreatedMessage("alert_1", fields!),
    ]);

    expect(stored).toEqual(live);
    expect(stored).toContain("Watching queue depth.");
    expect(stored).toContain("It expires in 24h.");
    expect(stored).toContain("Notifying: this chat, Ops webhook.");
  });

  it("shows the info and error lines a stored draft tool call produced", () => {
    const lines = historyTexts([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-update_alert_draft",
            toolCallId: "call_1",
            state: "output-available",
            input: {},
            output: { ok: true, patch: { what: "queue.depth" }, reason: "Set to queue depth." },
          },
          {
            type: "tool-update_alert_draft",
            toolCallId: "call_2",
            state: "output-available",
            input: {},
            output: { ok: false, errors: ["Unknown capability: queue.nope"] },
          },
        ],
      },
    ]);
    expect(lines).toEqual(["Set to queue depth.", "Unknown capability: queue.nope"]);
  });
});
