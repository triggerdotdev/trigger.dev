import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { textLinkClassName } from "~/components/primitives/TextLink";
import { AgentAnchor } from "./AgentText";

describe("AgentAnchor", () => {
  it("applies the app's standard link styling", () => {
    const html = renderToStaticMarkup(
      createElement(AgentAnchor, { href: "https://example.com" }, "docs")
    );

    expect(html).toContain(textLinkClassName());
  });
});
