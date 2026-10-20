import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AlertActivityTable, LEVEL_DESCRIPTIONS, LevelBreakdown } from "./AlertActivityTable";

vi.mock("~/components/primitives/DateTime", () => ({ DateTime: () => null }));

const event = {
  id: "e1",
  type: "raised",
  at: new Date("2026-01-01T00:00:00Z"),
  factsSummary: "fail rate 12%",
};

const render = () =>
  renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(
          MemoryRouter,
          null,
          createElement(AlertActivityTable, {
            alert: { events: [event] } as never,
            now: new Date("2026-01-02T00:00:00Z"),
            rowLink: () => ({ to: "/runs", label: "View related runs", kind: "runs" }),
          })
        )
      )
    )
  );

describe("AlertActivityTable related runs link", () => {
  it("uses only the tooltip, no native title on the row or button", () => {
    const html = render();
    expect(html).toContain('aria-label="View related runs"');
    expect(html).not.toMatch(/<tr[^>]*title=/);
    expect(html).not.toContain('title="View related runs"');
    expect(html).toContain('title="fail rate 12%"');
  });
});

describe("AlertActivityTable Level header", () => {
  it("renders the info trigger on the Level header", () => {
    const th = render().match(/<th[\s\S]*?Level[\s\S]*?<\/th>/)![0];
    expect(th).toContain("data-state=");
  });

  it("lists every level with its description", () => {
    const html = renderToStaticMarkup(createElement(LevelBreakdown));
    for (const [level, description] of Object.entries(LEVEL_DESCRIPTIONS)) {
      expect(html).toContain(level);
      expect(html).toContain(description);
    }
  });
});
