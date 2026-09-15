import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  AgentMarkdownTable,
  AgentMarkdownTableCell,
  AgentMarkdownTableHeaderCell,
} from "./AgentMarkdownTable";
import type { HastLikeNode } from "./agent-markdown-table";

function textNode(value: string): HastLikeNode {
  return { type: "text", value };
}

function markup(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, element)
    )
  );
}

describe("AgentMarkdownTableCell", () => {
  it("truncates a long value but keeps the full text in the title", () => {
    const longValue = "a".repeat(40);
    const node: HastLikeNode = { type: "element", tagName: "td", children: [textNode(longValue)] };

    const html = renderToStaticMarkup(createElement(AgentMarkdownTableCell, { node }, longValue));

    expect(html).toContain(`title="${longValue}"`);
    expect(html).toContain("truncate");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("font-mono");
    expect(html).toContain("text-xs");
  });

  it("flattens inline children (e.g. a link) into the title", () => {
    const node: HastLikeNode = {
      type: "element",
      tagName: "td",
      children: [textNode("see "), { type: "element", tagName: "a", children: [textNode("docs")] }],
    };

    const html = renderToStaticMarkup(createElement(AgentMarkdownTableCell, { node }, "see docs"));

    expect(html).toContain('title="see docs"');
  });
});

describe("AgentMarkdownTableCell vertical rhythm", () => {
  it("gives a cell with inline code the same td classes as a cell with plain text", () => {
    const plainNode: HastLikeNode = {
      type: "element",
      tagName: "td",
      children: [textNode("plain")],
    };
    const codeNode: HastLikeNode = {
      type: "element",
      tagName: "td",
      children: [{ type: "element", tagName: "code", children: [textNode("code")] }],
    };

    const plainHtml = renderToStaticMarkup(
      createElement(AgentMarkdownTableCell, { node: plainNode }, "plain")
    );
    const codeHtml = renderToStaticMarkup(
      createElement(AgentMarkdownTableCell, { node: codeNode }, createElement("code", null, "code"))
    );

    const tdClass = (html: string) => html.match(/<td[^>]*class="([^"]*)"/)?.[1];
    const plainClass = tdClass(plainHtml);
    const codeClass = tdClass(codeHtml);

    expect(plainClass).toBeTruthy();
    expect(plainClass).toBe(codeClass);
    expect(plainClass).toContain("leading-5");
    expect(plainClass).toContain("align-middle");
    expect(plainClass).toContain("py-1");
  });
});

describe("AgentMarkdownTableHeaderCell", () => {
  it("applies the same nowrap/truncate rule to header cells", () => {
    const text = "Column header";
    const node: HastLikeNode = { type: "element", tagName: "th", children: [textNode(text)] };

    const html = renderToStaticMarkup(createElement(AgentMarkdownTableHeaderCell, { node }, text));

    expect(html).toContain(`title="${text}"`);
    expect(html).toContain("truncate");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("font-mono");
    expect(html).toContain("text-xs");
  });
});

describe("AgentMarkdownTable card container", () => {
  it("has no vertical padding on the card, in the card and toolbar row", () => {
    const node: HastLikeNode = {
      type: "element",
      tagName: "table",
      children: [
        {
          type: "element",
          tagName: "thead",
          children: [
            {
              type: "element",
              tagName: "tr",
              children: [{ type: "element", tagName: "th", children: [textNode("a")] }],
            },
          ],
        },
        {
          type: "element",
          tagName: "tbody",
          children: [
            {
              type: "element",
              tagName: "tr",
              children: [{ type: "element", tagName: "td", children: [textNode("1")] }],
            },
          ],
        },
      ],
    };

    const html = markup(createElement(AgentMarkdownTable, { node }));

    const cardMatch = html.match(/class="([^"]*rounded-lg[^"]*)"/);
    expect(cardMatch).not.toBeNull();
    const cardClass = cardMatch?.[1] ?? "";
    expect(cardClass).not.toMatch(/\bp[tb]-/);
  });

  it("keeps the tools menu and Maximize button always visible, not hover-revealed", () => {
    const node: HastLikeNode = {
      type: "element",
      tagName: "table",
      children: [
        {
          type: "element",
          tagName: "tbody",
          children: [
            {
              type: "element",
              tagName: "tr",
              children: [{ type: "element", tagName: "td", children: [textNode("1")] }],
            },
          ],
        },
      ],
    };

    const html = markup(createElement(AgentMarkdownTable, { node }));

    expect(html).toContain("More actions");
    expect(html).toContain("Maximize chart");
    expect(html).not.toContain("opacity-0");
  });

  it("marks its wrapper with data-agent-table, for the scoped inline-code size rule", () => {
    const node: HastLikeNode = {
      type: "element",
      tagName: "table",
      children: [
        {
          type: "element",
          tagName: "tbody",
          children: [
            {
              type: "element",
              tagName: "tr",
              children: [{ type: "element", tagName: "td", children: [textNode("1")] }],
            },
          ],
        },
      ],
    };

    const html = markup(createElement(AgentMarkdownTable, { node }));

    expect(html).toContain("data-agent-table");
  });
});

describe("agent table inline code size (tailwind.css)", () => {
  function readTailwindCss() {
    const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../tailwind.css");
    return readFileSync(cssPath, "utf8");
  }

  it("scopes inline code to text-xs under [data-agent-table], leaving other inline code untouched", () => {
    const css = readTailwindCss();
    const rule = css.match(/\[data-agent-table\]\s*code[^{]*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("text-xs");
    expect(rule).toContain("py-0");
    expect(rule).toContain("leading-5");
    expect(rule).toContain("align-baseline");
  });

  it("is not nested under .streamdown-container, so it still matches inside the fullscreen dialog's portal", () => {
    const css = readTailwindCss();
    const ruleStart = css.indexOf("[data-agent-table] code");
    expect(ruleStart).toBeGreaterThan(-1);

    // The rule's own selector line has no leading '&' (nesting) and stands outside the
    // .streamdown-container block, which closes with a lone '}' before this line.
    const selectorLine = css.slice(
      css.lastIndexOf("\n", ruleStart) + 1,
      css.indexOf("{", ruleStart)
    );
    expect(selectorLine.trim()).toBe("[data-agent-table] code:not(pre code)");

    const containerEnd = css.indexOf(".streamdown-container {");
    expect(containerEnd).toBeGreaterThan(-1);
    expect(ruleStart).toBeGreaterThan(css.indexOf("\n}\n", containerEnd));
  });
});
