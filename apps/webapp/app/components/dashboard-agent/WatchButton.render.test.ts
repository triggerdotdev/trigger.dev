import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentProvider } from "./dashboardAgentLauncher";
import { WatchButton } from "./WatchButton";

/**
 * `WatchButton` reads `watchEnabled` off the provider it can't render without — this proves
 * the flag, not just the missing-provider case `WatchButton.tsx`'s own comment already covers.
 */
function markup(watchEnabled: boolean) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(
          DashboardAgentProvider,
          {
            value: {
              open: false,
              setOpen: () => {},
              openWith: () => {},
              openWithWatch: () => {},
              unreadWakes: 0,
              unreadWork: 0,
              watchEnabled,
            },
          },
          createElement(WatchButton, { spec: { kind: "run_finished", runId: "run_1" } as never })
        )
      )
    )
  );
}

describe("WatchButton", () => {
  it("renders nothing while watch functionality is disabled", () => {
    expect(markup(false)).toBe("");
  });

  it("renders the button once watch functionality is enabled", () => {
    expect(markup(true)).toContain("Watch");
  });
});
