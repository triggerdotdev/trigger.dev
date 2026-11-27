import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AIReplyCopyButton } from "./AIQueryInput";

describe("AIReplyCopyButton", () => {
  it.each([
    ["finished reply", "Sorry, I can only write queries.", true],
    ["empty text", "", false],
  ])("%s", (_name, text, hasCopy) => {
    const html = renderToStaticMarkup(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, createElement(AIReplyCopyButton, { text }))
      )
    );
    expect(html.includes('aria-label="Copy"')).toBe(hasCopy);
  });
});
