// @vitest-environment jsdom
import type { UIMessage } from "@ai-sdk/react";
import type * as RemixReactModule from "@remix-run/react";
import { createElement, useState, type ComponentProps, type ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { QueryAlertAnalysis } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import {
  alertCreatedMessage,
  groupCreatedMessage,
  joinPlanItemKeys,
  REVIEW_MESSAGE,
} from "~/components/alerts/alertCreatedCard";
import { resolveCapability } from "./alert-creation/flow-state";
import { DashboardAgentTurns } from "./DashboardAgentMessages";
import {
  MonitoringPlanHostProvider,
  PlanWizardSlot,
  type MonitoringPlanHost,
} from "./MonitoringPlanBlock";
import { useMonitoringPlanState } from "./useMonitoringPlanState";

const CHANNELS = vi.hoisted(() => [
  { id: "ch_1", name: "Ops email", type: "EMAIL" },
  { id: "ch_2", name: "Pager", type: "WEBHOOK" },
]);

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof RemixReactModule>()),
  useInRouterContext: () => false,
  Link: ({ to, children }: { to: string; children: ReactNode }) =>
    createElement("a", { href: to }, children),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/", search: "" }),
  useFetcher: () => {
    const [url, setUrl] = useState<string>();
    return {
      data: url?.startsWith("/resources/alerts/channels") ? { channels: CHANNELS } : undefined,
      load: setUrl,
    };
  },
}));
vi.mock("~/hooks/useOrganizations", () => ({
  useOptionalOrganization: () => ({ slug: "org", id: "org1" }),
  useOrganization: () => ({ slug: "org", id: "org1" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useOptionalProject: () => ({ slug: "proj", id: "proj1" }),
  useProject: () => ({ slug: "proj", id: "proj1" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useOptionalEnvironment: () => ({ slug: "prod", id: "env1", type: "PRODUCTION" }),
  useEnvironment: () => ({ slug: "prod", id: "env1", type: "PRODUCTION" }),
}));

const ANALYZE_PATH = "/resources/orgs/org/projects/proj/env/prod/alerts/analyze-query";
const QUERY = "SELECT count() AS failures FROM runs";
const ANALYSIS: QueryAlertAnalysis = {
  ok: true,
  analyzerVersion: 1,
  sources: [{ sourceId: "runs" }],
  columns: [],
  modes: [
    {
      mode: "threshold",
      shape: "scalar",
      measures: [{ column: "failures", type: "UInt64", countLike: true }],
      groupColumns: [],
      absenceAllowed: true,
    },
  ],
  unsupported: [],
  errors: [],
  limits: {
    minCadenceSec: 600,
    maxWindowSec: 86_400,
    maxGroups: 500,
    maxMatchRowsPerEval: 200,
    detailRows: 10,
  },
  suggestedName: "failures on runs",
};

let failAnalysis = false;
const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  if (String(url) === ANALYZE_PATH) {
    if (failAnalysis) return new Response("{}", { status: 500 });
    return new Response(
      JSON.stringify({ analysis: ANALYSIS, names: { "threshold:failures": "failures on runs" } })
    );
  }
  if (String(url) === "/resources/alerts/create") {
    return new Response(JSON.stringify({ ok: true, alertId: "alert_new" }));
  }
  if (String(url) === "/resources/alerts/group") {
    return new Response(
      JSON.stringify({ ok: true, alertId: "group_new", memberAlertIds: ["m_1", "m_2"] })
    );
  }
  return new Response("{}");
});

Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const curatedItem = {
  id: "p1",
  title: "Failure rate",
  summary: "Failure rate above 10%",
  detail: "Fires when the failure rate of all tasks climbs above 10%.",
  description: "Catch a failure spike after the deploy.",
  draft: {
    area: "runs",
    what: "runs.failure_rate",
    condition: { kind: "threshold", value: 10 },
    notifiers: [{ type: "channel", channelId: "ch_1" }],
  },
};
const queryItem = {
  id: "p2",
  title: "Failures query",
  description: "Watch the raw failure count.",
  draft: {
    area: "query",
    query: QUERY,
    querySignalChoice: { mode: "threshold", measure: "failures" },
    condition: { operator: ">", value: 5, windowSec: 3600 },
    notifiers: [{ type: "channel", channelId: "ch_1" }],
  },
};

function planMessage(id: string, output: unknown): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-plan_monitoring",
        toolCallId: `call_${id}`,
        state: "output-available",
        input: {},
        output,
      },
    ],
  } as unknown as UIMessage;
}

const okPlan = (items: unknown[]) => ({ ok: true, plan: { goal: "Watch the deploy", items } });

type HostOverrides = Partial<MonitoringPlanHost>;

function Harness({ messages, overrides }: { messages: UIMessage[]; overrides?: HostOverrides }) {
  const plans = useMonitoringPlanState("chat_1");
  const [wizardSlot, setWizardSlot] = useState<HTMLElement | null>(null);
  const host: MonitoringPlanHost = {
    ...plans,
    chatId: "chat_1",
    channels: CHANNELS,
    environmentTitle: "Production",
    alertDetailPath: (id) => `/alerts/${id}`,
    sendText: (text) => sent.push(text),
    wizardSlot,
    setWizardSlot,
    ...overrides,
  };
  return createElement(
    "div",
    null,
    createElement(
      MonitoringPlanHostProvider,
      { value: host },
      createElement(
        "div",
        { "data-testid": "transcript" },
        createElement(DashboardAgentTurns, {
          messages,
          activity: null,
          onIntent: (intent) => intents.push(intent),
        })
      ),
      createElement(PlanWizardSlot)
    )
  );
}

let sent: string[] = [];
let intents: unknown[] = [];
let container: HTMLElement;
let root: Root;

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(messages: UIMessage[], overrides?: HostOverrides) {
  await act(async () =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(ShortcutsProvider, null, createElement(Harness, { messages, overrides }))
      )
    )
  );
  await flush();
}

const transcript = () => document.querySelector<HTMLElement>("[data-testid=transcript]")!;
const buttons = (scope: HTMLElement, label: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).filter(
    (b) => b.textContent === label
  );
const createBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === "/resources/alerts/create")
    .map(([, init]) => JSON.parse(init!.body as string));

const stepCard = () =>
  document.querySelector<HTMLElement>("[data-testid=plan-wizard-slot] [role=dialog]");
const question = () => stepCard()?.getAttribute("aria-label");
const optionRow = (label: string) =>
  Array.from(stepCard()!.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    b.textContent?.startsWith(label)
  )!;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await flush();
};
const groupBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === "/resources/alerts/group")
    .map(([, init]) => JSON.parse(init!.body as string));
const open = () => click(buttons(transcript(), "Sounds good")[0]!);
const HOW = "One alert or separate?";

async function toCreate(mode: "As a group" | "Separately" = "Separately") {
  for (let i = 0; i < 30 && !buttons(stepCard()!, "Create").length; i++) {
    if (question() === HOW) {
      await click(optionRow(mode));
      continue;
    }
    const next = buttons(stepCard()!, "Continue").find((b) => !b.disabled);
    await click(
      next ?? stepCard()!.querySelector<HTMLButtonElement>("[aria-label='Next question']")!
    );
  }
}

async function toChannels(mode: "As a group" | "Separately") {
  for (let i = 0; i < 30 && question() !== "Where should it notify you?"; i++) {
    if (question() === HOW) {
      await click(optionRow(mode));
      continue;
    }
    const next = buttons(stepCard()!, "Continue").find((b) => !b.disabled);
    await click(
      next ?? stepCard()!.querySelector<HTMLButtonElement>("[aria-label='Next question']")!
    );
  }
}

const absenceItem = {
  id: "p3",
  title: "Runs going quiet",
  description: "Catch the scheduler stalling.",
  draft: {
    area: "runs",
    what: "runs.created",
    condition: { kind: "absence", windowSec: 3600 },
    notifiers: [{ type: "channel", channelId: "ch_1" }],
  },
};

describe("MonitoringPlanBlock", () => {
  beforeEach(() => {
    sent = [];
    intents = [];
    fetchMock.mockClear();
    failAnalysis = false;
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // Catches: the proposal missing its items, or the wizard opening without a confirmation.
  it("shows only the proposal until Sounds good opens the wizard in the slot", async () => {
    const message = planMessage("m1", {
      ok: true,
      plan: { goal: "Watch", intro: "Watch the failure rate?", items: [curatedItem, queryItem] },
    });
    await mount([message]);
    expect(transcript().textContent).toContain("Watch the failure rate?");
    expect(transcript().textContent).toContain(`${curatedItem.summary} — ${curatedItem.detail}`);
    expect(transcript().querySelectorAll("input, [role=dialog]")).toHaveLength(0);
    expect(stepCard()).toBeNull();
    await open();
    expect(transcript().querySelectorAll("[role=dialog]")).toHaveLength(0);
    expect(question()).toBe("What to watch?");
    expect(optionRow(queryItem.title).textContent).toContain(queryItem.description);
    const block = (title: string) =>
      optionRow(title).querySelector<HTMLElement>("[data-testid=query-alert-query]");
    expect(block(queryItem.title)?.textContent).toContain(QUERY);
    expect(block(curatedItem.title)).toBeNull();
  });

  // Catches: the evidence card dropped from a plan turn, text above a live proposal, the plan
  // not last, or the turn's text hidden once the proposal is answered.
  it("shows the evidence card, then the plan, in a plan turn", async () => {
    const card = {
      type: "investigation",
      id: "inv_1",
      revision: 0,
      version: 1,
      investigation: {
        outcome: "concluded",
        severity: "crit",
        confidence: "high",
        title: "A tool card from the same turn",
        headline: "Every attempt dies on a null order id.",
        remediation: "Guard the receipt builder.",
        hypotheses: [],
        evidence: [],
      },
    };
    const view = {
      type: "tool-render_view",
      state: "output-available",
      output: { blocks: [card] },
    };
    const message = planMessage("m1", okPlan([curatedItem]));
    message.parts.unshift(view as never, { type: "text", text: "Here is a plan." });
    await mount([message]);
    expect(transcript().textContent).not.toContain("Here is a plan.");
    const text = transcript().textContent!;
    expect(text.indexOf(card.investigation.title)).toBeGreaterThan(-1);
    expect(text.indexOf(card.investigation.title)).toBeLessThan(text.indexOf("Sounds good"));
    const reply = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Not this" }],
    } as unknown as UIMessage;
    await mount([message, reply]);
    expect(transcript().textContent).toContain("Here is a plan.");
    expect(transcript().textContent).toContain(card.investigation.title);
  });

  // Catches: Set up a watch not sending its text, staying clickable after a click or once the
  // plan has arrived, or a later plan retiring the block's other buttons.
  it("sends Set up a watch once and retires the button when the plan arrives", async () => {
    const actions = {
      type: "actions",
      id: "act_1",
      revision: 0,
      version: 1,
      actions: [
        { label: "Set up a watch", intent: { kind: "ask", prompt: "Set up a watch" } },
        { label: "Dig deeper", intent: { kind: "ask", prompt: "Dig deeper" } },
      ],
    };
    const evidence = {
      id: "e1",
      role: "assistant",
      parts: [
        { type: "text", text: "Want me to set up a watch so you're told if it hits?" },
        { type: "tool-render_view", state: "output-available", output: { blocks: [actions] } },
      ],
    } as unknown as UIMessage;
    const button = () => buttons(transcript(), "Set up a watch")[0]!;
    await mount([evidence]);
    await click(button());
    expect(intents).toEqual([{ kind: "ask", prompt: "Set up a watch" }]);
    expect(button().disabled).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    await mount([evidence]);
    expect(button().disabled).toBe(false);
    const reply = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Set up a watch" }],
    } as unknown as UIMessage;
    await mount([evidence, reply, planMessage("m2", okPlan([curatedItem]))]);
    expect(button().disabled).toBe(true);
    expect(buttons(transcript(), "Dig deeper")[0]!.disabled).toBe(false);
  });

  // Catches: Not this not reaching the agent, or the proposal coming back once it is answered.
  it("sends Not this and hides the answered proposal", async () => {
    const plan = planMessage("m1", okPlan([curatedItem, queryItem]));
    await mount([plan]);
    await click(buttons(transcript(), "Not this")[0]!);
    expect(sent).toEqual(["Not this"]);
    const reply = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Not this" }],
    } as unknown as UIMessage;
    await mount([plan, reply]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
  });

  const decision = (id: string, value: string, state = "output-available") =>
    ({
      id,
      role: "assistant",
      parts: [
        {
          type: "tool-plan_decision",
          toolCallId: `call_${id}`,
          state,
          input: { decision: value },
          output: { ok: true, decision: value },
        },
      ],
    }) as unknown as UIMessage;

  const lineagePlan = (items: unknown[]) => ({
    ok: true,
    plan: { goal: "Watch the deploy", lineage: "goal_a", items },
  });

  // Catches: a typed confirmation ignored, leaving the buttons and no wizard.
  it("opens the wizard for a typed confirmation", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, queryItem])), decision("m2", "confirm")]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
    expect(question()).toBe("What to watch?");
  });

  // Catches: a typed refusal ignored, leaving the buttons up.
  it("hides the proposal for a typed refusal", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, queryItem])), decision("m2", "dismiss")]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
    expect(stepCard()).toBeNull();
  });

  // Catches: a decision applying to a plan that comes after it.
  it("does not confirm a plan that follows the decision", async () => {
    await mount([
      planMessage("m1", lineagePlan([curatedItem])),
      decision("m2", "confirm"),
      planMessage("m3", lineagePlan([curatedItem, queryItem])),
    ]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(1);
    expect(stepCard()).toBeNull();
  });

  // Catches: "One alert or separate?" asked for a single pick.
  it("skips the group question for a single picked item", async () => {
    await mount([
      planMessage("m1", {
        ok: true,
        plan: { goal: "Watch", group: true, items: [curatedItem, queryItem] },
      }),
    ]);
    await open();
    await click(optionRow(queryItem.title));
    await click(buttons(stepCard()!, "Continue")[0]!);
    expect(question()).not.toBe(HOW);
    expect(question()).not.toBe(curatedItem.summary);
    expect(stepCard()!.textContent).not.toContain("1 of 1");
  });

  // Catches: the shared channels reaching only some of the separate alerts.
  it("writes the channels chosen once into every separate alert", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, absenceItem]))]);
    await open();
    await toChannels("Separately");
    await click(optionRow("Pager"));
    await toCreate();
    await click(buttons(stepCard()!, "Create")[0]!);
    expect(createBodies()).toMatchObject([
      {
        transcriptChatId: "chat_1",
        form: { capabilityKey: "runs.failure_rate", notifierChannelIds: ["ch_1", "ch_2"] },
      },
      {
        transcriptChatId: "chat_1",
        form: { capabilityKey: "runs.created", notifierChannelIds: ["ch_1", "ch_2"] },
      },
    ]);
    expect(stepCard()).toBeNull();
  });

  // Catches: the name typed for one separate alert staying in the next alert's name input.
  it("gives each separate alert its own name input", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, absenceItem]))]);
    await open();
    await toChannels("Separately");
    await click(optionRow("Pager"));
    await click(buttons(stepCard()!, "Continue")[0]!);
    const nameInput = () => stepCard()!.querySelector<HTMLInputElement>("input[aria-label=Name]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        nameInput(),
        "First typed"
      );
      nameInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons(stepCard()!, "Continue")[0]!);
    expect(nameInput().value).not.toBe("First typed");
    expect(nameInput().value).not.toBe("");
  });

  // Catches: separate plan alerts shown twice, or their transcript cards opening with the
  // wizard's review line.
  it("shows one card per separate alert once the transcript has them", async () => {
    const plan = planMessage("m1", okPlan([curatedItem, absenceItem]));
    await mount([plan]);
    await open();
    await toCreate();
    fetchMock
      .mockImplementationOnce(async () => new Response(JSON.stringify({ alertId: "alert_a" })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ alertId: "alert_b" })));
    await click(buttons(stepCard()!, "Create")[0]!);
    const fields = (name: string) => ({
      name,
      conditionSummary: "",
      scopeLabel: "All runs",
      behavior: "recurring" as const,
      notifyLabel: "Ops email",
    });
    const [first, second] = createBodies();
    await mount([
      plan,
      alertCreatedMessage("alert_a", fields("First alert"), first.planItemKey) as never,
      alertCreatedMessage("alert_b", fields("Second alert"), second.planItemKey) as never,
    ]);
    expect(transcript().querySelectorAll("a[href^='/alerts/alert_']")).toHaveLength(0);
    expect(transcript().textContent).toContain("First alert is active.");
    expect(transcript().textContent).toContain("Second alert is active.");
    expect(transcript().textContent).not.toContain(REVIEW_MESSAGE);
  });

  // Catches: a failed second create sending the wizard back to its first step, hiding the error.
  it("stays on the Create step with the error when a separate create fails", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, absenceItem]))]);
    await open();
    await toCreate();
    fetchMock
      .mockImplementationOnce(async () => new Response(JSON.stringify({ alertId: "alert_a" })))
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: "Scope not allowed" }), { status: 400 })
      );
    await click(buttons(stepCard()!, "Create")[0]!);
    expect(createBodies()).toHaveLength(2);
    expect(buttons(stepCard()!, "Create")).toHaveLength(1);
    expect(stepCard()!.textContent).toContain("Scope not allowed");
  });

  // Catches: the group taking the drafts' channels or ignoring the typed name, member cards
  // next to the group card, or the plan coming back after the group is in the transcript.
  it("creates one group with the shared channels and name", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, queryItem]))]);
    await open();
    await toChannels("As a group");
    await click(optionRow("Pager"));
    await click(buttons(stepCard()!, "Continue")[0]!);
    const nameInput = stepCard()!.querySelector<HTMLInputElement>("input[aria-label=Name]")!;
    expect(nameInput.value).toBe("Watch the deploy");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        nameInput,
        "Deploy watch"
      );
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const groupFields = {
      name: "Deploy watch",
      compositeMode: "any" as const,
      memberNames: ["a", "b"],
      channelNames: [],
    };
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            alertId: "group_new",
            memberAlertIds: ["m_1", "m_2"],
            message: groupCreatedMessage("group_new", groupFields),
          })
        )
    );
    await click(buttons(stepCard()!, "Create")[0]!);
    expect(createBodies()).toHaveLength(0);
    expect(groupBodies()).toMatchObject([
      {
        compositeMode: "any",
        name: "Deploy watch",
        notifierChannelIds: ["ch_1", "ch_2"],
        transcriptChatId: "chat_1",
        members: [
          {
            form: {
              capabilityKey: "runs.failure_rate",
              value: 10,
              notifierChannelIds: ["ch_1", "ch_2"],
            },
          },
          {
            form: {
              capabilityKey: "custom.query",
              query: QUERY,
              windowMinutes: 60,
              notifierChannelIds: ["ch_1", "ch_2"],
            },
          },
        ],
      },
    ]);
    const members = groupBodies()[0].members as {
      transcriptChatId?: string;
      planItemKey: string;
    }[];
    expect(members.map((m) => m.transcriptChatId)).toEqual([undefined, undefined]);
    const activeCards = () => transcript().textContent!.split("is active.").length - 1;
    expect(activeCards()).toBe(1);
    expect(transcript().textContent).toContain("Deploy watch is active.");

    const groupCard = groupCreatedMessage(
      "group_new",
      groupFields,
      joinPlanItemKeys(members.map((m) => m.planItemKey))
    );
    await mount([planMessage("m1", okPlan([curatedItem, queryItem])), groupCard as never]);
    expect(activeCards()).toBe(1);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
  });

  // Catches: a reloaded chat offering a plan again although its group card is in the transcript.
  it("restores a created group from the transcript after a reload", async () => {
    const plan = planMessage("m1", okPlan([curatedItem, queryItem]));
    await mount([plan]);
    await open();
    await toCreate("As a group");
    await click(buttons(stepCard()!, "Create")[0]!);
    const keys = (groupBodies()[0].members as { planItemKey: string }[]).map((m) => m.planItemKey);
    const groupCard = groupCreatedMessage(
      "group_new",
      { name: "Deploy watch", compositeMode: "any", memberNames: ["a", "b"], channelNames: [] },
      joinPlanItemKeys(keys)
    );
    act(() => root.unmount());
    root = createRoot(container);
    await mount([plan, groupCard as never]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
    expect(transcript().textContent!.split("is active.")).toHaveLength(2);
  });

  // Catches: group member expiries computed before the click.
  it("computes member expiries when Create is clicked", async () => {
    const expiring = (item: typeof curatedItem | typeof absenceItem) => ({
      ...item,
      draft: { ...item.draft, behavior: { expiry: "1h" } },
    });
    await mount([planMessage("m1", okPlan([expiring(curatedItem), expiring(absenceItem)]))]);
    await open();
    await toCreate("As a group");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const clickedAt = Date.now();
    await click(buttons(stepCard()!, "Create")[0]!);
    const members = groupBodies()[0].members as { form: { expiresAt: string } }[];
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(Date.parse(member.form.expiresAt)).toBeGreaterThanOrEqual(clickedAt + 3_600_000);
    }
  });

  // Catches: the plan horizon applied only to a group, leaving separate alerts without an expiry.
  it("gives each separate alert the plan horizon as its expiry", async () => {
    await mount([
      planMessage("m1", {
        ok: true,
        plan: { goal: "Watch the deploy", horizon: "2h", items: [curatedItem, absenceItem] },
      }),
    ]);
    await open();
    await toCreate();
    const clickedAt = Date.now();
    await click(buttons(stepCard()!, "Create")[0]!);
    const bodies = createBodies() as { form: { expiresAt?: string } }[];
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(Date.parse(body.form.expiresAt!)).toBeGreaterThanOrEqual(clickedAt + 7_200_000);
    }
  });

  // Catches: a health item with a default state condition dropped from the proposal.
  it("lists a health item whose state condition has only defaults", async () => {
    const health = {
      id: "p8",
      title: "Overall health",
      description: "Watch prod health.",
      draft: {
        area: "health",
        what: "health.all",
        condition: { kind: "state", compositeMode: "any" },
      },
    };
    await mount([planMessage("m1", okPlan([curatedItem, health]))]);
    expect(transcript().textContent).toContain(curatedItem.summary);
    expect(transcript().textContent).toContain("Overall health");
  });

  // Catches: a bare health.all item that can't be created without typing every threshold.
  it("creates a bare health item with the default thresholds", async () => {
    const health = {
      id: "p8",
      title: "Overall health",
      description: "Watch prod health.",
      draft: {
        area: "health",
        what: "health.all",
        condition: { kind: "state", compositeMode: "any" },
        notifiers: [{ type: "channel", channelId: "ch_1" }],
      },
    };
    await mount([planMessage("m1", okPlan([health]))]);
    await open();
    await toCreate();
    await click(buttons(stepCard()!, "Create")[0]!);
    expect(createBodies()).toMatchObject([
      {
        form: {
          capabilityKey: "health.all",
          compositeMode: "any",
          components: ["health.flow", "health.execution", "health.liveness"],
          conditionParams: {
            schedulingDelayMs: 30000,
            backlogCount: 1000,
            failureRatePct: 10,
            durationP95Ms: 300000,
            silenceSec: 300,
          },
        },
      },
    ]);
  });

  // Catches: a query item that failed analysis keeping the plan unfinished, so the proposal
  // returns after the other item is created.
  it("finishes the plan once the available item is created and the query failed analysis", async () => {
    failAnalysis = true;
    const plan = planMessage("m1", okPlan([curatedItem, queryItem]));
    await mount([plan]);
    await open();
    await toCreate();
    await click(buttons(stepCard()!, "Create")[0]!);
    expect(createBodies()).toHaveLength(1);
    expect(stepCard()).toBeNull();
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
    const created = {
      id: "alert_created:alert_old",
      role: "assistant",
      parts: [
        {
          type: "data-view",
          data: {
            blocks: [
              {
                type: "alert_created",
                id: "alert:alert_old",
                revision: 0,
                version: 1,
                alertId: "alert_old",
                name: "Failure rate",
                rows: [],
                planItemKey: createBodies()[0].planItemKey,
              },
            ],
          },
        },
      ],
    } as unknown as UIMessage;
    act(() => root.unmount());
    root = createRoot(container);
    await mount([plan, created]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
  });

  // Catches: a query item created as an absence alert when its condition is a threshold but
  // its signal choice says absence.
  it("creates a query item with its threshold condition and summary name", async () => {
    const query = "SELECT count() AS triggered FROM runs";
    const item = {
      id: "p6",
      title: "Triggered runs",
      summary: "Triggered runs above 500 in 10m",
      description: "Catch a trigger spike.",
      draft: {
        area: "query",
        query,
        condition: { kind: "threshold", operator: ">", value: 500, windowSec: 600 },
        querySignalChoice: { mode: "absence", measure: "triggered" },
        notifiers: [{ type: "channel", channelId: "ch_1" }],
      },
    };
    const analysis = {
      ...ANALYSIS,
      modes: [
        {
          mode: "threshold",
          shape: "scalar",
          measures: [{ column: "triggered", type: "UInt64", countLike: true }],
          groupColumns: [],
          absenceAllowed: true,
        },
      ],
      suggestedName: "triggered on runs",
    };
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            analysis,
            names: {
              "threshold:triggered": "triggered on runs",
              "absence:triggered": "No triggered on runs",
            },
          })
        )
    );
    await mount([planMessage("m1", okPlan([item]))]);
    await open();
    await toCreate();
    await click(buttons(stepCard()!, "Create")[0]!);
    expect(createBodies()).toMatchObject([
      {
        name: "Triggered runs above 500 in 10m",
        form: {
          capabilityKey: "custom.query",
          conditionKind: "threshold",
          operator: ">",
          value: 500,
          windowMinutes: 10,
          querySignalChoice: { mode: "threshold", measure: "triggered" },
        },
      },
    ]);
  });

  // Catches: a created card repeated by a later plan of the same lineage.
  it("shows one created card when a later plan supersedes the creating one", async () => {
    const lineage = (id: string, items: unknown[]) =>
      planMessage(id, { ok: true, plan: { goal: "Watch the deploy", lineage: "goal_a", items } });
    const fields = {
      name: "First alert",
      conditionSummary: "",
      scopeLabel: "All runs",
      behavior: "recurring" as const,
      notifyLabel: "Ops email",
    };
    const first = lineage("m1", [curatedItem]);
    await mount([first]);
    await open();
    await toCreate();
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ alertId: "alert_a", message: alertCreatedMessage("alert_a", fields) })
        )
    );
    await click(buttons(stepCard()!, "Create")[0]!);
    const activeCards = () => transcript().textContent!.split("First alert is active.").length - 1;
    expect(activeCards()).toBe(1);
    const card = alertCreatedMessage("alert_a", fields, createBodies()[0].planItemKey);
    await mount([first, card as never, lineage("m2", [curatedItem])]);
    expect(activeCards()).toBe(1);
  });

  // Catches: an item's own steps starting without saying which item and what comes next.
  it("opens each item with an intro step before its own steps", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, absenceItem]))]);
    await open();
    await click(buttons(stepCard()!, "Continue")[0]!);
    await click(optionRow("Separately"));
    expect(question()).toBe(curatedItem.summary);
    const titles = () => stepCard()!.querySelectorAll("[data-testid=wizard-title]");
    expect(titles()).toHaveLength(1);
    expect(titles()[0]!.textContent).toBe(`1 of 2 · ${curatedItem.summary}`);
    await click(buttons(stepCard()!, "Continue")[0]!);
    expect(question()).not.toBe(curatedItem.summary);
    expect(titles()).toHaveLength(1);
    expect(titles()[0]!.textContent).toContain(`1 of 2 · ${curatedItem.summary}`);
  });

  // Catches: a stored item without a condition offered in the list.
  it("hides an item that has no condition", async () => {
    const bare = {
      ...absenceItem,
      id: "p7",
      title: "Bare item",
      draft: { ...curatedItem.draft, condition: { kind: "threshold" } },
    };
    await mount([planMessage("m1", okPlan([curatedItem, bare]))]);
    await open();
    expect(optionRow("Bare item")).toBeUndefined();
  });

  // Catches: tool error text leaking into the transcript.
  it("renders nothing for a failed plan", async () => {
    await mount([
      planMessage("m1", { ok: false, errors: [{ id: "p1", message: "missing condition" }] }),
    ]);
    expect(transcript().textContent).not.toContain("missing condition");
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
  });

  // Catches: a reopened plan whose items are all created showing the proposal again.
  it("shows only the created card when a fully created plan is reopened", async () => {
    const plan = planMessage("m1", okPlan([curatedItem]));
    await mount([plan]);
    await open();
    await toCreate();
    await click(buttons(stepCard()!, "Create")[0]!);
    const created = {
      id: "alert_created:alert_old",
      role: "assistant",
      parts: [
        {
          type: "data-view",
          data: {
            blocks: [
              {
                type: "alert_created",
                id: "alert:alert_old",
                revision: 0,
                version: 1,
                alertId: "alert_old",
                name: "Failure rate",
                rows: [],
                planItemKey: createBodies()[0].planItemKey,
              },
            ],
          },
        },
      ],
    } as unknown as UIMessage;
    act(() => root.unmount());
    root = createRoot(container);
    await mount([plan, created]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(0);
    expect(transcript().textContent).toContain("Failure rate is active.");
  });

  // Catches: a closed wizard staying shut after a new typed confirmation, or "Sounds good" lost.
  it("reopens a closed wizard on a new typed confirmation", async () => {
    const plan = planMessage("m1", okPlan([curatedItem, queryItem]));
    await mount([plan, decision("m2", "confirm")]);
    await click(stepCard()!.querySelector<HTMLElement>("[aria-label=Close]")!);
    expect(stepCard()).toBeNull();
    expect(buttons(transcript(), "Sounds good")).toHaveLength(1);
    await mount([plan, decision("m2", "confirm"), decision("m3", "confirm")]);
    expect(question()).toBe("What to watch?");
  });

  // Catches: an unfinished or failed plan_decision call treated as a decision.
  it.each(["input-available", "output-error"])(
    "ignores a decision part in %s state",
    async (state) => {
      await mount([planMessage("m1", okPlan([curatedItem])), decision("m2", "confirm", state)]);
      expect(buttons(transcript(), "Sounds good")).toHaveLength(1);
      expect(stepCard()).toBeNull();
    }
  );

  // Catches: a decision binding to a plan emitted after it in the same assistant message.
  it("keeps a newer plan in the same message untouched by the decision", async () => {
    const [m1, m2] = [planMessage("m1", lineagePlan([curatedItem])), decision("m2", "confirm")];
    const newer = planMessage("m3", lineagePlan([curatedItem, queryItem]));
    const merged = {
      ...m2,
      parts: [...m2.parts, ...newer.parts],
    } as unknown as UIMessage;
    await mount([m1, merged]);
    expect(buttons(transcript(), "Sounds good")).toHaveLength(1);
    expect(stepCard()).toBeNull();
  });

  // Catches: a late typed confirmation reopening the wizard for an already created plan.
  it("ignores a typed confirmation for an already created plan", async () => {
    const plan = planMessage("m1", okPlan([curatedItem]));
    await mount([plan]);
    await open();
    await toCreate();
    await click(buttons(stepCard()!, "Create")[0]!);
    const created = {
      id: "alert_created:alert_old",
      role: "assistant",
      parts: [
        {
          type: "data-view",
          data: {
            blocks: [
              {
                type: "alert_created",
                id: "alert:alert_old",
                revision: 0,
                version: 1,
                alertId: "alert_old",
                name: "Failure rate",
                rows: [],
                planItemKey: createBodies()[0].planItemKey,
              },
            ],
          },
        },
      ],
    } as unknown as UIMessage;
    act(() => root.unmount());
    root = createRoot(container);
    await mount([plan, created, decision("m2", "confirm")]);
    expect(stepCard()).toBeNull();
  });

  // Catches: a revision keeping picks of changed items, or re-offering a created item.
  it("keeps created cards and unchanged picks across a revised plan", async () => {
    const lineage = (id: string, items: unknown[]) =>
      planMessage(id, { ok: true, plan: { goal: "Watch the deploy", lineage: "goal_a", items } });
    const changedQuery = {
      ...queryItem,
      draft: { ...queryItem.draft, condition: { operator: ">", value: 9, windowSec: 3600 } },
    };
    const first = lineage("m1", [curatedItem, queryItem, absenceItem]);
    await mount([first]);
    await open();
    await click(optionRow(queryItem.title));
    await click(optionRow(absenceItem.title));
    await toCreate();
    await click(buttons(stepCard()!, "Create")[0]!);
    await mount([first, lineage("m2", [curatedItem, changedQuery, absenceItem])]);
    await open();
    const pressed = (title: string) => optionRow(title).getAttribute("aria-pressed");
    expect(optionRow(curatedItem.summary).disabled).toBe(true);
    expect(pressed(queryItem.title)).toBe("true");
    expect(pressed(absenceItem.title)).toBe("false");
  });

  // Catches: a single item still gets an intro card before its own steps
  it("shows the pick card then the item's first step, without an intro, for one item", async () => {
    await mount([planMessage("m1", okPlan([curatedItem]))]);
    await open();
    expect(question()).toBe("What to watch?");
    expect(optionRow(curatedItem.summary)).toBeTruthy();
    await click(buttons(stepCard()!, "Continue")[0]!);
    expect(question()).not.toBe(curatedItem.summary);
    expect(question()).not.toBe("What to watch?");
  });

  // Catches: intro renders the model detail (with concrete numbers) instead of the registry description
  it("shows the registry description on the intro, not the model detail", async () => {
    await mount([planMessage("m1", okPlan([curatedItem, absenceItem]))]);
    await open();
    await click(buttons(stepCard()!, "Continue")[0]!);
    await click(optionRow("Separately"));
    expect(question()).toBe(curatedItem.summary);
    expect(stepCard()!.textContent).toContain(resolveCapability("runs.failure_rate")!.description);
    expect(stepCard()!.textContent).not.toContain(curatedItem.detail);
  });
});
