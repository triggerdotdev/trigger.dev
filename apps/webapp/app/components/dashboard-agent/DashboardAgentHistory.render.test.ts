import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardAgentHistoryMenu, type DashboardAgentChat } from "./DashboardAgentHistory";

function render(chats: DashboardAgentChat[]) {
  return renderToStaticMarkup(
    createElement(DashboardAgentHistoryMenu, {
      chats,
      currentChatId: "",
      now: Date.now(),
      onSelect: () => {},
      onRequestDelete: () => {},
    })
  );
}

describe("DashboardAgentHistoryMenu", () => {
  it("tags an alert creation chat with New alert", () => {
    const html = render([
      { id: "chat_1", title: "Queue depth above 10", lastMessageAt: null, kind: "alert_creation" },
    ]);
    expect(html).toContain("New alert");
    expect(html).toContain("Queue depth above 10");
  });

  it("shows the tag alone while the title is still New alert", () => {
    const html = render([
      { id: "chat_3", title: "New alert", lastMessageAt: null, kind: "alert_creation" },
    ]);
    expect(html.match(/>New alert</g)).toHaveLength(1);
  });

  it("does not tag a plain chat", () => {
    const html = render([{ id: "chat_2", title: "Why did my run fail", lastMessageAt: null }]);
    expect(html).not.toContain("New alert");
  });
});
