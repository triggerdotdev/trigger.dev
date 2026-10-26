import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentLauncher, DashboardAgentProvider } from "./dashboardAgentLauncher";

function markup(open: boolean) {
  const agent = {
    open,
    setOpen: () => {},
    unreadWakes: 0,
    unreadWork: 0,
  } as unknown as React.ComponentProps<typeof DashboardAgentProvider>["value"];
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(
          DashboardAgentProvider,
          { value: agent },
          createElement(DashboardAgentLauncher)
        )
      )
    )
  );
}

describe("DashboardAgentLauncher", () => {
  it("fails when the button disappears or stays enabled while the panel is open", () => {
    const open = markup(true);
    expect(open).toContain("Ask Trigger");
    expect(open).toMatch(/<button[^>]*disabled=""[^>]*>/);
    expect(markup(false)).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("renders no tooltip trigger while the panel is open", () => {
    expect(markup(true)).not.toContain("data-state=");
    expect(markup(false)).toContain("data-state=");
  });
});
