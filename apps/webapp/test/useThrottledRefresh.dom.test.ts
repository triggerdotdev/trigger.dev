// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrottledRefresh } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/useThrottledRefresh";

const INTERVAL_MS = 5_000;

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.useRealTimers();
});

function render(initial: { signal: number; enabled?: boolean }) {
  let key = 0;
  function Harness({ signal, enabled }: { signal: number; enabled: boolean }) {
    key = useThrottledRefresh(signal, { enabled, intervalMs: INTERVAL_MS });
    return null;
  }
  const props = { signal: initial.signal, enabled: initial.enabled ?? true };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, props)));
  const update = (next: Partial<typeof props>) => {
    Object.assign(props, next);
    act(() => root!.render(createElement(Harness, { ...props })));
  };
  return {
    key: () => key,
    change: () => update({ signal: props.signal + 1 }),
    setEnabled: (enabled: boolean) => update({ enabled }),
  };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("useThrottledRefresh", () => {
  it("does not bump on mount", () => {
    const harness = render({ signal: 1 });
    advance(INTERVAL_MS * 2);
    expect(harness.key()).toBe(0);
  });

  it("bumps once for a single change", () => {
    const harness = render({ signal: 1 });
    harness.change();
    expect(harness.key()).toBe(1);
    advance(INTERVAL_MS * 2);
    expect(harness.key()).toBe(1);
  });

  it("bumps immediately, then once at the end of the window for a burst", () => {
    const harness = render({ signal: 1 });
    harness.change();
    expect(harness.key()).toBe(1);

    advance(1_000);
    harness.change();
    advance(1_000);
    harness.change();
    expect(harness.key()).toBe(1);

    advance(INTERVAL_MS - 2_000);
    expect(harness.key()).toBe(2);
    advance(INTERVAL_MS * 2);
    expect(harness.key()).toBe(2);
  });

  it("holds changes while hidden and bumps once on becoming visible", () => {
    const harness = render({ signal: 1 });
    setVisibility("hidden");
    harness.change();
    harness.change();
    advance(INTERVAL_MS * 2);
    expect(harness.key()).toBe(0);

    setVisibility("visible");
    expect(harness.key()).toBe(1);
    advance(INTERVAL_MS * 2);
    expect(harness.key()).toBe(1);
  });

  it("does not bump on becoming visible without a change", () => {
    const harness = render({ signal: 1 });
    setVisibility("hidden");
    setVisibility("visible");
    expect(harness.key()).toBe(0);
  });

  it("does not bump while disabled", () => {
    const harness = render({ signal: 1, enabled: false });
    harness.change();
    advance(INTERVAL_MS * 2);
    expect(harness.key()).toBe(0);
  });

  it("drops a pending trailing bump when disabled", () => {
    const harness = render({ signal: 1 });
    harness.change();
    harness.change();
    harness.setEnabled(false);
    advance(INTERVAL_MS * 2);
    expect(harness.key()).toBe(1);
  });
});
