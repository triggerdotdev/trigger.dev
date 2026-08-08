import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { escapeClosesPanel } from "./panel-escape";

/**
 * Escape has to reach the thing the user meant. Radix dismisses a popover or a dialog from a
 * document listener that runs after the panel's own handler and never marks the event handled,
 * so the panel has to decide for itself whether the keystroke came from inside it.
 */
describe("escapeClosesPanel", () => {
  it("closes the panel when Escape comes from the panel itself", () => {
    expect(
      escapeClosesPanel({ key: "Escape", defaultPrevented: false, targetInsidePanel: true })
    ).toBe(true);
  });

  it("leaves the panel open when Escape comes from a portalled layer", () => {
    // The history popover and the delete dialog both render outside the panel's DOM subtree.
    expect(
      escapeClosesPanel({ key: "Escape", defaultPrevented: false, targetInsidePanel: false })
    ).toBe(false);
  });

  it("stays out of the way once something else has handled the key", () => {
    expect(
      escapeClosesPanel({ key: "Escape", defaultPrevented: true, targetInsidePanel: true })
    ).toBe(false);
  });

  it("ignores every other key", () => {
    expect(
      escapeClosesPanel({ key: "Enter", defaultPrevented: false, targetInsidePanel: true })
    ).toBe(false);
    expect(escapeClosesPanel({ key: "j", defaultPrevented: false, targetInsidePanel: true })).toBe(
      false
    );
  });
});

/**
 * Structural guards, not behavioural proof: the delete confirmation's survival depends on where
 * it is mounted in the tree, which these assertions pin down without rendering anything.
 */
describe("the delete confirmation lives outside the history popover", () => {
  const header = readFileSync(new URL("./DashboardAgentHeader.tsx", import.meta.url), "utf8");
  const history = readFileSync(new URL("./DashboardAgentHistory.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./DashboardAgentPanel.tsx", import.meta.url), "utf8");

  const menuBody = history.slice(
    history.indexOf("export function DashboardAgentHistoryMenu"),
    history.indexOf("export function DashboardAgentDeleteChatDialog")
  );

  it("keeps no dialog and no pending state inside the popover's menu", () => {
    expect(menuBody).not.toContain("<Dialog");
    expect(menuBody).not.toContain("useState");
  });

  it("mounts the dialog in the header as a sibling of the popover, not within it", () => {
    const popoverEnd = header.indexOf("</Popover>");
    const dialog = header.indexOf("<DashboardAgentDeleteChatDialog");
    expect(popoverEnd).toBeGreaterThan(-1);
    expect(dialog).toBeGreaterThan(popoverEnd);
  });

  it("owns the pending chat in the header, so dismissing the popover cannot unmount it", () => {
    expect(header).toContain("const [pendingDelete, setPendingDelete] = useState");
  });

  it("gates the panel's Escape on the shared rule rather than defaultPrevented alone", () => {
    expect(panel).toContain("escapeClosesPanel({");
    expect(panel).toContain("panelRef.current?.contains(event.target as Node)");
    expect(panel).not.toContain('if (event.key !== "Escape" || event.defaultPrevented) return;');
  });
});
