import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AlertCreatedCard } from "./creationCards";
import { alertCreatedBlock, groupCreatedBlock, type CreatedCardFields } from "./alertCreatedCard";

function wrap(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, el)
      )
    )
  );
}

const CREATED_FIELDS: CreatedCardFields = {
  name: "Queue depth alert",
  conditionSummary: "Queue depth > 100 for 5m",
  scopeLabel: "All",
  behavior: "recurring",
  notifyLabel: "this chat",
  expiryLabel: "expires in 24h",
};

describe("AlertCreatedCard", () => {
  it("ends with a View alert button and no status block", () => {
    const html = wrap(
      createElement(AlertCreatedCard, {
        block: alertCreatedBlock("a_1", CREATED_FIELDS),
        alertDetailPath: "/alerts/a_1",
      })
    );
    expect(html).toContain('href="/alerts/a_1"');
    expect(html).toContain(">View alert<");
    expect(html).not.toContain("Status");
    expect(html).not.toContain("<dl");
  });

  it("formats a custom expiry on the client", () => {
    const expiresAt = "2030-01-02T03:04:05.000Z";
    const block = alertCreatedBlock("a_1", {
      ...CREATED_FIELDS,
      expiryLabel: undefined,
      expiresAt,
    });
    const html = wrap(createElement(AlertCreatedCard, { block }));
    expect(html).toContain(`It expires ${new Date(expiresAt).toLocaleString()}.`);
    expect(html).not.toContain(expiresAt);
  });

  // Catches: a created group card missing its members or link.
  it("renders a group with its members and a View alert link", () => {
    const html = wrap(
      createElement(AlertCreatedCard, {
        block: groupCreatedBlock("g_1", {
          name: "Prod group",
          compositeMode: "all",
          memberNames: ["A1", "A2", "A3", "A4", "A5", "A6", "A7"],
          channelNames: ["Ops"],
        }),
        alertDetailPath: "/alerts/g_1",
      })
    );
    expect(html).toContain("Prod group is active.");
    expect(html).toContain("Raises when: all of 7 alerts (A1, A2, A3, A4, A5, +2 more).");
    expect(html).not.toContain("A6");
    expect(html).toContain('href="/alerts/g_1"');
  });
});
