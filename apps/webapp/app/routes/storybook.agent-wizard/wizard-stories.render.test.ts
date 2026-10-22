import { createElement, Fragment, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { sectionsOnPage } from "../storybook.agent-ui/manifest";
import { WIZARD_STATES } from "./wizard-stories";

const html = (node: ReactNode) =>
  renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
      createElement(ShortcutsProvider, null, createElement(Fragment, null, node))
    )
  );

describe("wizard card storybook page", () => {
  // Mutation: leaving the wizard group on the Chat UI page fails this.
  it("lists the wizard sections on their own page, each with a state", () => {
    const ids = sectionsOnPage("wizard").map((section) => section.sectionId);
    expect(ids).toEqual([
      "wizard-card",
      "wizard-option-info",
      "wizard-entity",
      "wizard-custom-unit",
      "wizard-multi-param",
      "wizard-until",
      "wizard-error",
    ]);
    expect(sectionsOnPage("chat").some((section) => section.sectionId === "wizard-card")).toBe(
      false
    );
    for (const id of ids) expect(WIZARD_STATES[id]).toBeDefined();
  });

  it("renders the input states", () => {
    expect(html(WIZARD_STATES["wizard-option-info"])).toContain('aria-label="About Depth');
    expect(html(WIZARD_STATES["wizard-entity"])).toContain('aria-label="Queue"');
    const multi = html(WIZARD_STATES["wizard-multi-param"]);
    expect(multi).toContain("Queued runs above");
    expect(multi.lastIndexOf("Continue")).toBeGreaterThan(multi.indexOf("Queued runs above"));
    const error = html(WIZARD_STATES["wizard-error"]);
    expect(error).toContain("Must be greater than 0");
    expect(error).toContain("Must be in the future");
  });
});
