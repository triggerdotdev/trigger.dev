import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { LegacyAlertsSection } from "~/components/alerts/LegacyAlertsSection";
import type { LegacyAlertChannelRow } from "~/components/alerts/legacyAlertChannels";

vi.mock("~/components/primitives/Popover", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Popover: ({ children }: { children: unknown }) => children,
  PopoverVerticalEllipseTrigger: () => null,
  PopoverContent: ({ children }: { children: unknown }) => children,
}));
vi.mock("~/components/dashboard-agent/agent-identity", () => ({ AgentIcon: () => null }));

const channels: LegacyAlertChannelRow[] = [
  {
    id: "ch_1",
    name: "ops",
    channelKind: "Email",
    enabled: true,
    alertTypes: ["TASK_RUN", "DEPLOYMENT_FAILURE"],
    alertTypeLabels: [],
    environmentNames: ["production"],
  },
];

function render(canWrite = true, canDelete = true) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(LegacyAlertsSection, {
          channels,
          onReplace: () => {},
          onDelete: () => {},
          canWrite,
          canDelete,
        })
      )
    )
  );
}

describe("LegacyAlertsSection", () => {
  it("gives every row a Delete menu item, migratable included", () => {
    expect(render().match(/>Delete</g)).toHaveLength(2);
  });

  it("keeps the replace action on the migratable row", () => {
    expect(render()).toContain("Replace with new Alert");
  });

  it("disables Delete without write permission", () => {
    expect(render(false)).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Delete/s);
  });

  it("disables Delete without delete permission", () => {
    expect(render(true, false)).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Delete/s);
  });

  it("disables Replace without write permission", () => {
    expect(render(false)).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Replace/s);
    expect(render()).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Replace/s);
  });

  it("disables Delete and Replace from the row's own permissions", () => {
    const html = (row: Partial<LegacyAlertChannelRow>, canDelete = true) =>
      renderToStaticMarkup(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(LegacyAlertsSection, {
              channels: [{ ...channels[0], ...row }],
              onReplace: () => {},
              onDelete: () => {},
              canWrite: true,
              canDelete,
            })
          )
        )
      );
    const disabledDelete = /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Delete/s;
    expect(html({ canWrite: true, canDelete: false })).toMatch(disabledDelete);
    expect(html({ canWrite: false, canDelete: true })).toMatch(disabledDelete);
    expect(html({ canWrite: true, canDelete: true }, false)).toMatch(disabledDelete);
    expect(html({ canWrite: true, canDelete: true })).not.toMatch(disabledDelete);
  });
});
