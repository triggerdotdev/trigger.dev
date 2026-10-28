// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUsageFill } from "~/components/billing/usage/useUsageFill";

type Reads = Parameters<typeof useUsageFill>[2];
type Fill = ReturnType<typeof useUsageFill>;

// The hook only reads `pendingDays`; `owner` tells reads apart.
function reads(owner: string, pendingDays: number): Reads {
  const value = { owner, pendingDays } as never;
  return { usage: { ok: true, value }, projectUsage: { ok: true, value } };
}

function owner(fill: Fill | undefined) {
  return fill?.usage.ok ? (fill.usage.value as unknown as { owner: string }).owner : undefined;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
});

function stubFetch(reply: (url: string) => { status: number; body?: unknown }) {
  const fetch = vi.fn(async (url: string) => {
    const { status, body } = reply(url);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function render() {
  let latest: Fill | undefined;
  function Harness(props: { org: string; month: string; initial: Reads }) {
    latest = useUsageFill(props.org, props.month, props.initial);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return {
    show: (org: string, month: string, initial: Reads) =>
      act(() => root!.render(createElement(Harness, { org, month, initial }))),
    current: () => latest,
  };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

describe("useUsageFill", () => {
  it("polls until no days are pending", async () => {
    const replies = [reads("poll-1", 2), reads("poll-2", 0)];
    const fetch = stubFetch(() => ({
      status: 200,
      body: { month: "2026-10", ...replies.shift() },
    }));
    const page = render();

    page.show("acme", "2026-10", reads("loader", 4));
    await settle();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("/resources/orgs/acme/billing-usage?month=2026-10");
    expect(owner(page.current())).toBe("poll-2");
    expect(page.current()?.isFilling).toBe(false);
  });

  it("does not show another org's polled usage for the same month", async () => {
    stubFetch((url) => ({
      status: 200,
      body: { month: "2026-10", ...reads(url.includes("/acme/") ? "acme-poll" : "beta-poll", 1) },
    }));
    const page = render();

    page.show("acme", "2026-10", reads("acme-loader", 3));
    await settle();
    expect(owner(page.current())).toBe("acme-poll");

    page.show("beta", "2026-10", reads("beta-loader", 0));
    expect(owner(page.current())).toBe("beta-loader");
    expect(page.current()?.pendingDays).toBe(0);
  });

  it("keeps the last good reads and stops polling when a poll fails", async () => {
    const replies = [{ status: 200, body: { month: "2026-10", ...reads("poll-1", 2) } }];
    const fetch = stubFetch(() => replies.shift() ?? { status: 500 });
    const page = render();

    page.show("acme", "2026-10", reads("loader", 4));
    await settle();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(owner(page.current())).toBe("poll-1");
    expect(page.current()?.isFilling).toBe(false);
  });

  it("counts a day pending in both reads once", async () => {
    stubFetch(() => ({ status: 200, body: { month: "2026-10", ...reads("poll", 24) } }));
    const page = render();

    page.show("acme", "2026-10", reads("loader", 24));
    await settle();

    expect(page.current()?.pendingDays).toBe(24);
  });

  it("stops polling when a poll makes no progress", async () => {
    const fetch = stubFetch(() => ({
      status: 200,
      body: { month: "2026-10", ...reads("poll", 4) },
    }));
    const page = render();

    page.show("acme", "2026-10", reads("loader", 4));
    await settle();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.current()?.isFilling).toBe(false);
  });
});
