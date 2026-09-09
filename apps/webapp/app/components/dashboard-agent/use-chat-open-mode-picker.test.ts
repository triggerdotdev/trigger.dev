// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatOpenMode } from "~/utils/dashboardPreferences";
import {
  CHAT_OPEN_MODE_SAVE_ERROR,
  useChatOpenModePicker,
  type ChatOpenModePickerDeps,
} from "./use-chat-open-mode-picker";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

type Wire = Pick<ChatOpenModePickerDeps, "stored" | "fetcherState" | "fetcherData">;

/**
 * Drives the real hook the account page renders. `submit` and `onError` are plain
 * recorders and the fetcher's lifecycle is played back by re-rendering, the way Remix
 * would: submitting, then idle carrying the result.
 */
function renderPicker(stored: ChatOpenMode) {
  const submitted: ChatOpenMode[] = [];
  const errors: string[] = [];
  let latest!: ReturnType<typeof useChatOpenModePicker>;
  let wire: Wire = { stored, fetcherState: "idle", fetcherData: undefined };

  function Harness(props: Wire) {
    // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
    latest = useChatOpenModePicker({
      ...props,
      submit: (mode) => submitted.push(mode),
      onError: (message) => errors.push(message),
    });
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness, wire));
  });

  const rerender = (next: Partial<Wire>) => {
    wire = { ...wire, ...next };
    act(() => {
      root!.render(createElement(Harness, wire));
    });
  };

  return {
    submitted,
    errors,
    get desired() {
      return latest.desired;
    },
    pick(mode: ChatOpenMode) {
      act(() => latest.pick(mode));
    },
    inFlight() {
      rerender({ fetcherState: "submitting" });
    },
    /** The write landed: the action's result arrives and the route revalidates. */
    succeeds(nowStored: ChatOpenMode) {
      rerender({ fetcherState: "idle", fetcherData: { success: true }, stored: nowStored });
    },
    fails(error?: string) {
      rerender({ fetcherState: "idle", fetcherData: { success: false, error } });
    },
  };
}

describe("useChatOpenModePicker", () => {
  it("submits a pick once, and not again while the route revalidates", () => {
    const view = renderPicker("floating");

    view.pick("rightPanel");
    expect(view.submitted).toEqual(["rightPanel"]);

    view.inFlight();
    // The result is in but `stored` hasn't caught up yet.
    view.succeeds("floating");
    expect(view.submitted).toEqual(["rightPanel"]);

    view.succeeds("rightPanel");
    expect(view.submitted).toEqual(["rightPanel"]);
  });

  it("holds a second pick until the first settles, so the last pick wins", () => {
    const view = renderPicker("floating");

    view.pick("rightPanel");
    view.inFlight();
    view.pick("fullscreen");
    expect(view.submitted).toEqual(["rightPanel"]);

    view.succeeds("rightPanel");

    expect(view.submitted).toEqual(["rightPanel", "fullscreen"]);
    expect(view.desired).toBe("fullscreen");
  });

  it("sends a pick queued behind a failed write instead of rolling it back", () => {
    const view = renderPicker("floating");

    view.pick("rightPanel");
    view.inFlight();
    view.pick("fullscreen");
    view.fails();

    expect(view.submitted).toEqual(["rightPanel", "fullscreen"]);
    expect(view.desired).toBe("fullscreen");
    expect(view.errors).toEqual([CHAT_OPEN_MODE_SAVE_ERROR]);
  });

  it("rolls back to the stored mode on failure, and never retries the failed value", () => {
    const view = renderPicker("floating");

    view.pick("rightPanel");
    view.inFlight();
    view.fails("Not available");

    expect(view.submitted).toEqual(["rightPanel"]);
    expect(view.desired).toBe("floating");
    expect(view.errors).toEqual(["Not available"]);
  });

  it("stays usable after a failure: picking the failed mode again submits it", () => {
    const view = renderPicker("floating");

    view.pick("rightPanel");
    view.inFlight();
    view.fails();
    expect(view.submitted).toEqual(["rightPanel"]);

    view.pick("rightPanel");

    expect(view.submitted).toEqual(["rightPanel", "rightPanel"]);
    expect(view.desired).toBe("rightPanel");
    expect(view.errors).toEqual([CHAT_OPEN_MODE_SAVE_ERROR]);
  });

  it("picks a different mode after a failure without resending the failed one", () => {
    const view = renderPicker("floating");

    view.pick("rightPanel");
    view.inFlight();
    view.fails();

    view.pick("fullscreen");

    expect(view.submitted).toEqual(["rightPanel", "fullscreen"]);
    expect(view.errors).toEqual([CHAT_OPEN_MODE_SAVE_ERROR]);
  });
});
