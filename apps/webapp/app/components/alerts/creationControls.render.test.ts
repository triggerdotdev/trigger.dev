import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "~/components/dashboard-agent/agent-identity";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AgentManualToggle } from "./creationControls";

const ASK_TRIGGER_PATHS = renderToStaticMarkup(createElement(AgentIcon, {})).match(/<path[^>]*>/g)!;

describe("AgentManualToggle", () => {
  it("wears the Ask Trigger icon on Agent", () => {
    const html = renderToStaticMarkup(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(AgentManualToggle, { manual: false, onChange: () => {} })
        )
      )
    );
    expect(ASK_TRIGGER_PATHS.length).toBeGreaterThan(0);
    for (const path of ASK_TRIGGER_PATHS) expect(html).toContain(path);
  });
});
