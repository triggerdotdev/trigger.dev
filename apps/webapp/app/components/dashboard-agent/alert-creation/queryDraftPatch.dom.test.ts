// @vitest-environment jsdom
import type * as RemixReactModule from "@remix-run/react";
import { createElement, useEffect, useState, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryAlertTranscript,
  type QueryWatchPrefill,
} from "~/components/alerts/QueryAlertTranscript";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { ToolResultPayload } from "./draftPatch";
import { useCreationAgentSend, type CreationAgentSend } from "./useCreationAgentSend";

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof RemixReactModule>()),
  useFetcher: () => ({ data: undefined, load: () => {} }),
}));
vi.mock("~/hooks/useOrganizations", () => ({
  useOrganization: () => ({ slug: "org", id: "org1" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useProject: () => ({ slug: "proj", id: "proj1" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "prod", id: "env1", type: "PRODUCTION" }),
}));

const QUERY = "SELECT count() AS failures FROM runs";
const ANALYSIS = {
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

Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const harness: { send?: CreationAgentSend } = {};
let applied: unknown[] = [];

function Harness({ onSend }: { onSend: (send: CreationAgentSend) => void }) {
  const [watch, setWatch] = useState<QueryWatchPrefill>();
  const send = useCreationAgentSend({
    answers: {},
    onPatchApplied: (next) => applied.push(next),
    onQueryWatch: setWatch,
  });
  useEffect(() => onSend(send));
  return watch
    ? createElement(QueryAlertTranscript, { prefill: watch, alertDetailPath: (id) => id })
    : createElement(
        "div",
        { "data-testid": "curated" },
        send.systemLines.map((line) => line.text).join("\n")
      );
}

let container: HTMLElement;
let root: Root;

describe("a query draft patch from the agent", () => {
  beforeEach(() => {
    applied = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ analysis: ANALYSIS, names: {} })))
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(
            ShortcutsProvider,
            null,
            createElement(Harness, {
              onSend: (send) => {
                harness.send = send;
              },
            })
          )
        )
      )
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens the query card instead of patching the curated draft", async () => {
    const result: ToolResultPayload = {
      ok: true,
      patch: { area: "query", query: QUERY, querySignalChoice: { mode: "threshold" } } as never,
    };
    await act(async () => harness.send!.handleDraftPatches([result]));

    expect(document.querySelector("[data-testid=curated]")).toBeNull();
    expect(applied).toEqual([]);
    expect(document.querySelector("[data-testid=query-alert-flow]")).not.toBeNull();
    expect(document.querySelector("[role=dialog]")!.getAttribute("aria-label")).toBe(
      "Watch this query?"
    );
    expect(document.querySelector("[data-testid=query-alert-query]")!.textContent).toBe(QUERY);
  });

  it("carries a below-threshold operator into the card", async () => {
    const result: ToolResultPayload = {
      ok: true,
      patch: {
        area: "query",
        query: QUERY,
        querySignalChoice: { mode: "threshold", measure: "failures" },
        condition: { operator: "<" },
      } as never,
    };
    await act(async () => harness.send!.handleDraftPatches([result]));
    const row = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("[role=dialog] li button")).find(
        (b) => b.textContent === label
      )!;
    act(() => row("Continue").click());
    act(() => row("Value crosses a threshold").click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Threshold"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(row("Below").querySelector("[aria-label=Selected]")).not.toBeNull();
    expect(row("Above").querySelector("[aria-label=Selected]")).toBeNull();
  });
});
