import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentHeader } from "./DashboardAgentHeader";

function markup(actions?: React.ReactNode) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(DashboardAgentHeader, {
          title: "Chat",
          chats: [],
          currentChatId: "",
          onOpenHistory: () => {},
          onSelectChat: () => {},
          onDeleteChat: () => {},
          mode: "floating",
          onModeChange: () => {},
          onClose: () => {},
          actions,
        })
      )
    )
  );
}

describe("DashboardAgentHeader actions slot", () => {
  it("renders nothing extra when no action is passed", () => {
    expect(markup(undefined)).not.toContain("Manual setup");
  });

  it("renders the passed action, e.g. DEC-067's Manual setup button", () => {
    expect(markup(createElement("span", null, "Manual setup"))).toContain("Manual setup");
  });
});
