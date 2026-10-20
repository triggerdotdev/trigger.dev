import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { LegacyAlertsSection } from "./LegacyAlertsSection";
import type { LegacyAlertChannelRow } from "./legacyAlertChannels";

function legacyMarkup(channels: LegacyAlertChannelRow[]) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(LegacyAlertsSection, { channels, onReplace: () => {} })
      )
    )
  );
}

const LEGACY_CHANNEL: LegacyAlertChannelRow = {
  id: "channel_1",
  name: "On-call webhook",
  channelKind: "Webhook",
  enabled: true,
  alertTypes: ["TASK_RUN", "DEPLOYMENT_FAILURE"],
  alertTypeLabels: ["Task run failure", "Deployment failure"],
  environmentNames: ["production"],
};

describe("LegacyAlertsSection", () => {
  it("renders one table with one Replace button and a Coming soon pill", () => {
    const html = legacyMarkup([LEGACY_CHANNEL]);

    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).not.toContain("Ready to replace");
    expect(html).not.toContain(">Enabled<");
    expect(html).toContain("Task run failure");
    expect(html.match(/>Replace with new Alert</g)).toHaveLength(1);
    const soon = html.slice(html.indexOf("Deployment failure"));
    expect(soon).toContain("Coming soon");
    expect(soon).not.toContain(">Replace with new Alert<");
  });

  it("renders only Coming soon pills when nothing is replaceable", () => {
    const html = legacyMarkup([
      {
        ...LEGACY_CHANNEL,
        alertTypes: ["DEPLOYMENT_SUCCESS"],
        alertTypeLabels: ["Deployment success"],
      },
    ]);

    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).not.toContain(">Replace with new Alert<");
    expect(html).toContain("Coming soon");
  });

  it("renders nothing when there are no legacy channels", () => {
    expect(legacyMarkup([])).toBe("");
  });
});
