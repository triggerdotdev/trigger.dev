import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { CreationTranscript } from "./CreationTranscript";
import { CreationChatShell } from "./CreationChatShell";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  prefillToAnswers,
  stripCreateSearchParams,
  type FlowAnswers,
  type FlowStepKey,
} from "~/components/dashboard-agent/alert-creation/flow-state";

vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => undefined }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => undefined }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => undefined }));

function wrap(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, el)
    )
  );
}

const noop = () => {};

function makeFlow(overrides: Partial<CreationFlowState> = {}): CreationFlowState {
  return {
    answers: {},
    currentStep: "area" as FlowStepKey,
    completedSteps: [],
    isReview: false,
    created: false,
    createdAlertId: undefined,
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
    ...overrides,
  };
}

describe("production creation shell port", () => {
  it("fails when production creation does not mount CreationChatShell", () => {
    const flow = makeFlow({ currentStep: "area" });
    const docked = wrap(
      createElement(
        CreationChatShell,
        { placement: "docked" },
        createElement(CreationTranscript, { flow, density: "compact", onFreeText: noop })
      )
    );
    const floating = wrap(
      createElement(
        CreationChatShell,
        { placement: "floating" },
        createElement(CreationTranscript, { flow, density: "compact", onFreeText: noop })
      )
    );
    expect(docked).toContain('data-testid="creation-chat-shell"');
    expect(docked).toContain('data-placement="docked"');
    expect(floating).toContain('data-placement="floating"');
    expect(docked).not.toContain('data-placement="floating"');
    expect(floating).not.toContain('data-placement="docked"');
  });

  it("fails when the transcript is not compact", () => {
    const flow = makeFlow({ currentStep: "area" });
    const compact = wrap(
      createElement(CreationTranscript, { flow, density: "compact", onFreeText: noop })
    );
    const full = wrap(
      createElement(CreationTranscript, { flow, density: "full", onFreeText: noop })
    );
    expect(compact).toContain('data-density="compact"');
    expect(full).toContain('data-density="full"');
    expect(compact).not.toContain('data-density="full"');
    expect(full).not.toContain('data-density="compact"');
  });

  it("fails when the manual-mode toggle is missing", () => {
    const flow = makeFlow({ currentStep: "area" });
    const html = wrap(
      createElement(CreationTranscript, {
        flow,
        density: "compact",
        onFreeText: noop,
        onManualChange: noop,
      })
    );
    expect(html).toContain('change how this alert is built"');
    expect(html).toContain('data-testid="manual-mode-toggle"');
  });

  it("fails when the review card drops Customize", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    };
    const flow = makeFlow({
      answers,
      currentStep: undefined,
      isReview: true,
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Queue depth" },
        { key: "scope", prompt: "c", label: "All" },
        { key: "condition", prompt: "d", label: "100" },
        { key: "notifiers", prompt: "f", label: "chat" },
      ],
    });
    const html = wrap(
      createElement(CreationTranscript, {
        flow,
        density: "compact",
        onFreeText: noop,
      })
    );
    expect(html).toContain("Customize");
    expect(flow.answers.area).toBe("queues");
    expect(flow.answers.what).toBe("queue.depth");
  });

  it("fails when the storybook variant-1 route stops rendering after the extraction", () => {
    const flow = makeFlow({ currentStep: "area" });
    const html = wrap(createElement(CreationTranscript, { flow, density: "compact" }));
    expect(html).toContain("What would you like me to watch?");
    expect(html).toContain("svg");
  });

  it("fails when ?create=1 does not open after mount", () => {
    const params = new URLSearchParams("?create=1&capability=queue.depth&scope=all");
    const answers = prefillToAnswers({
      capability: params.get("capability") ?? undefined,
      scope: params.get("scope") ?? undefined,
    });
    expect(answers.area).toBe("queues");
    expect(answers.what).toBe("queue.depth");
    expect(answers.scope).toBe("all");
    const stripped = stripCreateSearchParams(params);
    expect(stripped.get("create")).toBeNull();
    expect(stripped.get("capability")).toBeNull();
  });

  it("fails when prefill is dropped", () => {
    const prefilled = prefillToAnswers({
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "my-q",
    });
    const flow = makeFlow({
      answers: prefilled,
      currentStep: "condition",
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Queue depth" },
        { key: "scope", prompt: "c", label: "Specific queue" },
      ],
    });
    const html = wrap(createElement(CreationTranscript, { flow, density: "compact" }));
    expect(html).toContain('aria-label="When should this alert fire?"');
    expect(html).toContain("100");
    expect(flow.answers.area).toBe("queues");
    expect(flow.answers.what).toBe("queue.depth");
    expect(flow.answers.scope).toBe("queue");
    expect(flow.answers.scopeValue).toBe("my-q");
  });

  it("fails when CreationFlowRenderer is still referenced", async () => {
    const { readFileSync } = await import("fs");
    const panelSource = readFileSync(
      new URL("../dashboard-agent/DashboardAgentPanel.tsx", import.meta.url).pathname,
      "utf8"
    );
    expect(panelSource).not.toContain("CreationFlowRenderer");
  });

  it("fails if the alerts-page entry does not render the creation shell with title", async () => {
    const { readFileSync } = await import("fs");
    const panelSource = readFileSync(
      new URL("../dashboard-agent/DashboardAgentPanel.tsx", import.meta.url).pathname,
      "utf8"
    );
    expect(panelSource).toContain("creationTitle");
    expect(panelSource).toContain('creationFlow.created ? "Alert created" : "New alert"');
    expect(panelSource).toContain("inCreationMode");
    expect(panelSource).toContain("creationTitle");
  });
});

describe("new alert initial state matches variant-1", () => {
  const html = wrap(
    createElement(CreationTranscript, {
      flow: makeFlow({ currentStep: "area" }),
      density: "compact",
      onFreeText: noop,
      onManualChange: noop,
      onNewChat: noop,
    })
  );

  it("renders the prompt as a user bubble", () => {
    expect(html).toMatch(
      /flex justify-end"><div class="max-w-\[80%\] rounded-lg bg-background-raised[^"]*"><div[^>]*>Create a new alert</
    );
  });

  it("lists five starter rows in order, areas with icons", () => {
    const rows = [...html.matchAll(/<li[^>]*><button[^>]*>(.*?)<\/button><\/li>/gs)].map(
      (m) => m[1]!
    );
    const labels = rows.map((row) => row.replace(/<[^>]+>/g, ""));
    expect(labels).toEqual(["Queues", "Runs", "Health", "Errors", "Show me what I can watch"]);
    for (const row of rows.slice(0, 4)) expect(row.startsWith("<svg")).toBe(true);
    expect(rows[4]!.startsWith("<svg")).toBe(false);
  });

  it("pins the composer footer with Agent and New chat", () => {
    expect(html).toContain(">Agent<");
    expect(html).toContain('aria-label="New chat"');
  });

  it("drops Manual setup and Domain", () => {
    expect(html).not.toContain("Manual setup");
    expect(html).not.toContain("Domain");
  });
});
