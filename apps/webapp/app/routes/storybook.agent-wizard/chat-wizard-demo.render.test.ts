import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { ChatWizardDemo } from "./chat-wizard-demo";

describe("wizard card storybook demo", () => {
  it("renders the first step with Skip and no Something else", () => {
    const html = renderToStaticMarkup(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(ShortcutsProvider, null, createElement(ChatWizardDemo))
      )
    );
    expect(html).toContain("What should this alert watch?");
    expect(html).not.toContain("Something else");
    expect(html).toContain("Skip");
  });
});
