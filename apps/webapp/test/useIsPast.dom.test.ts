// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIsPast } from "~/hooks/useIsPast";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const MINUTE = 60_000;
const iso = (ms: number) => new Date(T0 + ms).toISOString();

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.useRealTimers();
});

function render(expiresAt: string | undefined, serverNow = T0) {
  let past = false;
  function Harness() {
    past = useIsPast(expiresAt, serverNow);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness)));
  return () => past;
}

describe("useIsPast", () => {
  // Catches: a session open on the page never showing as expired until a reload.
  it("flips when the time passes", () => {
    const past = render(iso(MINUTE));
    expect(past()).toBe(false);

    act(() => vi.advanceTimersByTime(MINUTE - 1));
    expect(past()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(past()).toBe(true);
  });

  // Catches: a server clock behind the client's leaving an already expired session active.
  it("is past at once when the client's clock is already past it", () => {
    const past = render(iso(-MINUTE), T0 - 2 * MINUTE);
    act(() => vi.advanceTimersByTime(0));
    expect(past()).toBe(true);
  });

  // Catches: a timer that fires a moment before the time (timers and Date.now() use different
  // clocks) leaving the session active for good.
  it("flips even when the timer fires a little early", () => {
    const past = render(iso(MINUTE));
    vi.setSystemTime(T0 - 2);
    act(() => vi.advanceTimersByTime(MINUTE));
    expect(Date.now()).toBeLessThan(T0 + MINUTE);
    expect(past()).toBe(false);

    act(() => vi.advanceTimersByTime(2));
    expect(past()).toBe(true);
  });

  // Catches: setTimeout firing at once past its limit and marking a far-off time as past.
  it("doesn't flip early for a time past setTimeout's limit", () => {
    const past = render(iso(30 * 24 * 60 * MINUTE));
    act(() => vi.advanceTimersByTime(MINUTE));
    expect(past()).toBe(false);
  });
});
