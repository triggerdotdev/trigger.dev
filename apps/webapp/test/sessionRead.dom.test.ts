// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentSessionDetails,
  type SessionDetailsData,
} from "~/components/sessions/v1/sessionDetails";
import {
  SessionPanelStoreProvider,
  useSessionPanelStore,
  useSessionRead,
} from "~/components/sessions/v1/trace/sessionPanelStore";

const UPDATED_AT = "2026-11-01T00:02:00.000Z";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

const pageLoad = (status: "EXECUTING" | "COMPLETED_SUCCESSFULLY"): SessionDetailsData => ({
  updatedAt: UPDATED_AT,
  currentRun: { friendlyId: "run_5", status },
  runs: [
    {
      id: "sr_5",
      runFriendlyId: "run_5",
      reason: "continuation",
      triggeredAt: "2026-11-01T00:01:00.000Z",
      run: { friendlyId: "run_5", status },
    },
  ],
});

function render(initial: SessionDetailsData) {
  const seen: { details?: SessionDetailsData; store?: ReturnType<typeof useSessionPanelStore> } =
    {};
  function Pane({ loaded }: { loaded: SessionDetailsData }) {
    seen.store = useSessionPanelStore();
    seen.details = currentSessionDetails(loaded, useSessionRead(loaded));
    return null;
  }
  const renderWith = (loaded: SessionDetailsData) =>
    act(() =>
      root!.render(createElement(SessionPanelStoreProvider, null, createElement(Pane, { loaded })))
    );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  renderWith(initial);
  return { seen, renderWith };
}

describe("useSessionRead", () => {
  // Catches: a run that finished while Conversation was shown (no polls) going back to its older
  // polled status when the page reloads its data (Raw or channel toggle), as the session row is
  // unchanged.
  it("a new page load replaces an older Trace read", () => {
    const first = pageLoad("EXECUTING");
    const { seen, renderWith } = render(first);
    act(() =>
      seen.store!.setSessionRead(
        {
          closedAt: null,
          closedReason: null,
          expiresAt: null,
          updatedAt: UPDATED_AT,
          currentRunFriendlyId: "run_5",
        },
        [
          {
            friendlyId: "run_5",
            reason: "continuation",
            triggeredAt: "2026-11-01T00:01:00.000Z",
            status: "EXECUTING",
          },
        ]
      )
    );
    renderWith(first);
    expect(seen.store!.getSessionRead()).toBeDefined();

    renderWith(pageLoad("COMPLETED_SUCCESSFULLY"));

    expect(seen.details?.currentRun?.status).toBe("COMPLETED_SUCCESSFULLY");
    expect(seen.details?.runs[0]?.run?.status).toBe("COMPLETED_SUCCESSFULLY");
  });
});
