// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { LegacyAlertsSection } from "./LegacyAlertsSection";
import type { LegacyAlertChannelRow } from "./legacyAlertChannels";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function channel(id: string, name: string): LegacyAlertChannelRow {
  return {
    id,
    name,
    channelKind: "Webhook",
    enabled: true,
    alertTypes: ["TASK_RUN"],
    alertTypeLabels: ["Task run failure"],
    environmentNames: ["production"],
  };
}

describe("LegacyAlertsSection replace", () => {
  it("calls onReplace with the clicked row", () => {
    const onReplace = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(LegacyAlertsSection, {
              channels: [channel("c1", "Alpha"), channel("c2", "Beta")],
              onReplace,
            })
          )
        )
      )
    );

    const buttons = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Replace with new Alert"
    );
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());

    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace.mock.calls[0][0]).toMatchObject({ channelId: "c2", alertType: "TASK_RUN" });
  });
});
