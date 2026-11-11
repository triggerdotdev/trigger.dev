import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { TextLink } from "~/components/primitives/TextLink";

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, el)
      )
    )
  );
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1]);
}

describe("Callout links", () => {
  it("links to an app path", () => {
    const html = render(createElement(Callout, { variant: "docs", to: "/runs" }, "Runs"));
    expect(hrefs(html)).toEqual(["/runs"]);
  });

  it("links to a relative path", () => {
    const html = render(createElement(Callout, { variant: "docs", to: "../runs" }, "Runs"));
    expect(hrefs(html)).toEqual(["/runs"]);
  });

  it("links to an https URL in a new tab", () => {
    const html = render(
      createElement(Callout, { variant: "docs", to: "https://trigger.dev/docs" }, "Docs")
    );
    expect(hrefs(html)).toEqual(["https://trigger.dev/docs"]);
    expect(html).toContain('target="_blank"');
  });

  it("opens an https URL with an uppercase scheme in a new tab", () => {
    const html = render(
      createElement(Callout, { variant: "docs", to: "HTTPS://trigger.dev/docs" }, "Docs")
    );
    expect(hrefs(html)).toEqual(["https://trigger.dev/docs"]);
    expect(html).toContain('target="_blank"');
  });

  it("renders the content without a link for other targets", () => {
    for (const to of [
      "javascript:void(0)",
      "data:text/html,docs",
      "//example.com/docs",
      "../javascript:void(0)",
      "..///example.com/docs",
      "\\example.com/docs",
    ]) {
      const html = render(createElement(Callout, { variant: "docs", to }, "Docs"));
      expect(hrefs(html)).toEqual([]);
      expect(html).toContain("Docs");
    }
  });
});

describe("TextLink links", () => {
  it("links to an app path and an https URL", () => {
    expect(hrefs(render(createElement(TextLink, { to: "/runs" }, "Runs")))).toEqual(["/runs"]);
    expect(hrefs(render(createElement(TextLink, { href: "https://trigger.dev" }, "Site")))).toEqual(
      ["https://trigger.dev"]
    );
  });

  it("renders the text without a link for other targets", () => {
    const fromTo = render(createElement(TextLink, { to: "javascript:void(0)" }, "Runs"));
    const fromHref = render(createElement(TextLink, { href: "data:text/html,site" }, "Site"));

    expect(hrefs(fromTo)).toEqual([]);
    expect(fromTo).toContain("Runs");
    expect(hrefs(fromHref)).toEqual([]);
    expect(fromHref).toContain("Site");
  });
});

describe("LinkButton links", () => {
  it("links to an app path and an https URL", () => {
    expect(
      hrefs(render(createElement(LinkButton, { to: "/runs", variant: "secondary/small" }, "Runs")))
    ).toEqual(["/runs"]);
    expect(
      hrefs(
        render(
          createElement(
            LinkButton,
            { to: "https://trigger.dev", variant: "secondary/small" },
            "Site"
          )
        )
      )
    ).toEqual(["https://trigger.dev"]);
  });

  it("renders the button without a link for other targets", () => {
    const html = render(
      createElement(LinkButton, { to: "javascript:void(0)", variant: "secondary/small" }, "Runs")
    );
    expect(hrefs(html)).toEqual([]);
    expect(html).toContain("Runs");
  });
});
