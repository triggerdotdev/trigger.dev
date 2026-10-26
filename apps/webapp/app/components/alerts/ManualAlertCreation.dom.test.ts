// @vitest-environment jsdom
import type * as RemixReactModule from "@remix-run/react";
import { createElement, useState, type ComponentProps, type ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { DraftPrefillParams } from "~/components/dashboard-agent/alert-creation/flow-state";
import { ManualAlertCreationDock } from "./ManualAlertCreation";

const CURRENT_ENV_CHANNELS = [{ id: "ch1", name: "Ops webhook", type: "WEBHOOK" }];
const PROJECT_CHANNELS = [
  ...CURRENT_ENV_CHANNELS,
  { id: "ch_prod", name: "Prod pager", type: "WEBHOOK" },
];

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
      data: url?.startsWith("/resources/alerts/channels")
        ? {
            channels: url.includes("environmentId=") ? CURRENT_ENV_CHANNELS : PROJECT_CHANNELS,
            canWrite: true,
          }
        : undefined,
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
vi.mock("~/hooks/useTypedMatchData", () => ({ useTypedMatchesData: () => undefined }));
vi.mock("~/hooks/useFeatures", () => ({ useFeatures: () => ({ queueMetricsEnabled: true }) }));

const fetchMock = vi.fn(async (url: string | URL | Request) => {
  if (String(url) === "/resources/alerts/create") {
    return new Response(JSON.stringify({ ok: true, alertId: "a1" }));
  }
  if (String(url).includes("/alerts/legacy?_data=")) {
    return new Response(
      JSON.stringify({ count: 1, message: "Created 1 alert", legacyRemaining: false })
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

const fieldset = (step: string) =>
  document.querySelector<HTMLFieldSetElement>(`fieldset[data-step="${step}"]`);
const combobox = (step: string) =>
  fieldset(step)?.querySelector<HTMLButtonElement>("button[role=combobox]") ?? null;
const popover = (select: HTMLElement) =>
  document.getElementById(select.getAttribute("aria-controls") ?? "");
const options = (select: HTMLElement) =>
  Array.from(popover(select)?.querySelectorAll<HTMLElement>("[role=option]") ?? []);
const click = (el: HTMLElement) => act(() => el.click());
const open = (select: HTMLElement) => {
  act(() => select.focus());
  act(() => select.click());
};
function pick(step: string, label: string) {
  const select = combobox(step)!;
  open(select);
  const found = options(select).find((o) => o.textContent === label);
  if (!found) throw new Error(`no ${label}: ${options(select).map((o) => o.textContent)}`);
  click(found);
}
const checkbox = (step: string, label: string) =>
  Array.from(fieldset(step)!.querySelectorAll<HTMLLabelElement>("[data-checkbox-list] label"))
    .find((l) => l.textContent === label)!
    .querySelector<HTMLInputElement>("input")!;
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === label
  );

let container: HTMLElement;
let root: Root;
const onCreated = vi.fn();
const onClose = vi.fn();
const onReplaced = vi.fn();

function render(prefill: DraftPrefillParams) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            ManualAlertCreationDock,
            {
              open: true,
              prefill,
              alertDetailPath: (id: string) => `/alerts/${id}`,
              onCreated,
              onReplaced,
              onClose,
            },
            createElement("div", { "data-testid": "page" }, "page")
          )
        )
      )
    )
  );
}

describe("ManualAlertCreation", () => {
  beforeEach(() => {
    fetchMock.mockClear();
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

  it("walks the real form, posts the alert and reports the created id", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
    try {
      render({ area: "runs", capability: "runs.failed", scope: "task", scopeValue: "x" });
      pick("condition", "50");
      pick("expiry", "For 24 hours");
      click(checkbox("notifiers", "Ops webhook"));
      click(button("Done")!);
      await act(async () => button("Create alert")!.click());
      const calls = fetchMock.mock.calls.filter(([url]) => url === "/resources/alerts/create");
      expect(calls).toHaveLength(1);
      const init = (calls[0] as unknown as [string, RequestInit])[1];
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        organizationId: "org1",
        projectId: "proj1",
        environmentId: "env1",
        name: "Failed runs above 50 on x",
        expiry: "24h",
        form: {
          capabilityKey: "runs.failed",
          scopeType: "task",
          scopeValue: "x",
          conditionKind: "threshold",
          operator: ">",
          value: 50,
          windowMinutes: 10,
          expiresAt: "2026-01-02T00:00:00.000Z",
          notifierChannelIds: ["ch1"],
        },
      });
      expect(onCreated).toHaveBeenCalledWith("a1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh draft when the prefill changes", () => {
    render({ area: "runs", capability: "runs.failed", scope: "task", scopeValue: "x" });
    pick("condition", "50");
    expect(combobox("condition")!.textContent).toBe("50");
    render({ area: "runs", capability: "runs.failed", scope: "task", scopeValue: "y" });
    expect(combobox("condition")!.textContent).toBe("Select…");
    pick("condition", "50");
    expect(fieldset("scope")!.textContent).toContain("y");
    expect(fieldset("scope")!.textContent).not.toContain("x");
  });

  it("docks beside the page with the panel header and no chat controls", () => {
    render({ area: "runs", capability: "runs.failed", scope: "task", scopeValue: "x" });
    expect(document.querySelector("[data-testid=page]")).not.toBeNull();
    const panel = document.querySelector("[data-testid=manual-alert-panel]")!;
    const title = Array.from(panel.querySelectorAll("span")).find(
      (span) => span.textContent === "New alert"
    )!;
    expect(title.className).toContain("truncate text-sm font-medium text-text-bright");
    expect(panel.querySelector("[aria-label^='Change layout']")).toBeNull();
    expect(panel.querySelector("[aria-haspopup]:not([role=combobox])")).toBeNull();
    expect(panel.querySelector("[data-testid=manual-mode-toggle]")).toBeNull();
    expect(panel.querySelector("textarea")).toBeNull();
    click(panel.querySelector<HTMLButtonElement>("[aria-label='Close (Esc)']")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("replaces a legacy subscription through the legacy route", async () => {
    render({
      capability: "runs.failed",
      scope: "all",
      replace: {
        channelId: "ch_prod",
        channelName: "Prod pager",
        alertType: "TASK_RUN",
        environments: [
          { id: "env1", type: "PRODUCTION", slug: "prod", branchName: null },
          { id: "env2", type: "DEVELOPMENT", slug: "dev", branchName: null },
        ],
      },
    });
    pick("expiry", "No expiry");
    expect(checkbox("notifiers", "Prod pager").checked).toBe(true);
    click(button("Done")!);
    await act(async () => button("Create alert")!.click());
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/alerts/legacy"));
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `/orgs/org/projects/proj/env/prod/alerts/legacy?_data=${encodeURIComponent(
        "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.legacy"
      )}`
    );
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(init.body as FormData)).toEqual({
      intent: "replace",
      channelId: "ch_prod",
      alertType: "TASK_RUN",
      environmentIds: "env1,env2",
      value: "0",
      windowMinutes: "10",
      scopeType: "all",
      notifierChannelIds: "ch_prod",
    });
    expect(fetchMock.mock.calls.some(([u]) => u === "/resources/alerts/create")).toBe(false);
    expect(onReplaced).toHaveBeenCalledWith({
      count: 1,
      message: "Created 1 alert",
      legacyRemaining: false,
    });
  });
});
