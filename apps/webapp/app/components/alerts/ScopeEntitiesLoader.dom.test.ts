// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeEntitiesLoader, type ScopeEntities } from "./ScopeEntitiesLoader";

vi.mock("@remix-run/react", () => ({ useInRouterContext: () => true }));
vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => ({ slug: "o" }) }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => ({ slug: "p" }) }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => ({ slug: "dev" }) }));

const queue = (name: string) => ({ name, type: "custom" });
const firstPage = Array.from({ length: 100 }, (_, i) => queue(`q${i}`));

let root: Root;
let container: HTMLElement;
const onLoad = vi.fn<[ScopeEntities], void>();
const fetchMock = vi.fn(async (url: string) => {
  const query = new URL(url, "http://x").searchParams.get("query");
  const queues = query === "sync" ? [queue("task/sync-inventory")] : firstPage;
  return { ok: true, json: async () => ({ queues, hasMore: !query }) };
});

function render(search?: string, kind: "queue" | "task" = "queue") {
  act(() => root.render(createElement(ScopeEntitiesLoader, { kind, search, onLoad })));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  onLoad.mockClear();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ScopeEntitiesLoader search", () => {
  it("queries the server for a search term and returns matches beyond the first page", async () => {
    render();
    await flush();
    render("sync");
    await flush(250);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes("query=sync"))).toBe(true);
    expect(onLoad).toHaveBeenLastCalledWith({ kind: "queue", names: ["task/sync-inventory"] });
  });

  it("debounces typing and restores the cached first page on clear", async () => {
    render();
    await flush();
    render("s");
    await flush(100);
    render("sync");
    await flush(250);
    expect(fetchMock.mock.calls.filter((c) => c[0].includes("query="))).toHaveLength(1);
    render("");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onLoad.mock.lastCall?.[0].names).toHaveLength(100);
  });

  it("does not search tasks", async () => {
    render("sync", "task");
    await flush(250);
    expect(fetchMock.mock.calls.every((c) => !c[0].includes("query="))).toBe(true);
  });
});
