import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AGENT_AI_DISCLOSURE } from "./AgentAiDisclosure";
import {
  DashboardAgentComposer,
  type DashboardAgentComposerLayout,
} from "./DashboardAgentComposer";
import { AgentPanelColumn } from "./panel-layout";

const CONTEXT = "context-slot";
const TRAILING_ACTION = "trailing-action-slot";
const NOTICE = "notice-slot";

function render(element: ReactElement) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, element)
    )
  );
}

function composer(layout: DashboardAgentComposerLayout, isStreaming = false) {
  return createElement(DashboardAgentComposer, {
    layout,
    value: "Why did this run fail?",
    onChange: () => {},
    onSubmit: () => {},
    onStop: () => {},
    isStreaming,
    context: createElement("span", null, CONTEXT),
    trailingAction: createElement("span", null, TRAILING_ACTION),
    notice: createElement("span", null, NOTICE),
  });
}

function occurrences(html: string, needle: string) {
  return html.split(needle).length - 1;
}

/**
 * Markup order stands in for the layout: the panel is everything from the text box up to the
 * notice, which sits under it. The webapp renders on the server, so this needs no DOM.
 */
describe.each(["docked", "hero"] as const)("the %s composer", (layout) => {
  it("leaves the AI disclosure to the panel column around it", () => {
    expect(render(composer(layout))).not.toContain(AGENT_AI_DISCLOSURE);
  });

  it("keeps the context, the trailing action and Send inside the panel, once each", () => {
    const html = render(composer(layout));
    const textBox = html.indexOf("<textarea");
    const notice = html.indexOf(NOTICE);
    for (const needle of [CONTEXT, TRAILING_ACTION, 'aria-label="Send"']) {
      expect(occurrences(html, needle), needle).toBe(1);
      expect(html.indexOf(needle), needle).toBeGreaterThan(textBox);
      expect(html.indexOf(needle), needle).toBeLessThan(notice);
    }
  });

  it("puts Stop where Send was while a turn is in flight", () => {
    const html = render(composer(layout, true));
    expect(html).not.toContain('aria-label="Send"');
    const stop = html.indexOf('aria-label="Stop generating"');
    expect(stop).toBeGreaterThan(html.indexOf(TRAILING_ACTION));
    expect(stop).toBeLessThan(html.indexOf(NOTICE));
  });
});

describe("the panel column", () => {
  it("ends with the AI disclosure, once, under the composer and its notice", () => {
    const html = render(createElement(AgentPanelColumn, { fullscreen: false }, composer("docked")));
    expect(occurrences(html, AGENT_AI_DISCLOSURE)).toBe(1);
    expect(html.indexOf(AGENT_AI_DISCLOSURE)).toBeGreaterThan(html.indexOf(NOTICE));
  });

  it("ends with it whatever fills the panel, so it stays put from new chat to chat", () => {
    const html = render(
      createElement(AgentPanelColumn, { fullscreen: true }, createElement("div", null, "hero-slot"))
    );
    expect(occurrences(html, AGENT_AI_DISCLOSURE)).toBe(1);
    expect(html.indexOf(AGENT_AI_DISCLOSURE)).toBeGreaterThan(html.indexOf("hero-slot"));
  });
});
