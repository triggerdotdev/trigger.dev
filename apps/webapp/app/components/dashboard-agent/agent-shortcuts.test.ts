import { describe, expect, it } from "vitest";
import { hotkeyOptions } from "~/hooks/useShortcutKeys";
import { ASK_AI_SHORTCUT } from "./ask-ai-channels";
import { TOGGLE_PANEL_SHORTCUT } from "./dashboardAgentLauncher";

const enabled = { isEnabled: true };

describe("the agent's shortcuts", () => {
  it("asks for Cmd-J's browser default to be prevented", () => {
    expect(TOGGLE_PANEL_SHORTCUT.key).toBe("j");
    expect(TOGGLE_PANEL_SHORTCUT.modifiers).toEqual(["mod"]);
    expect(hotkeyOptions({ shortcut: TOGGLE_PANEL_SHORTCUT, ...enabled }).preventDefault).toBe(
      true
    );
  });

  it("fires from inside the composer", () => {
    const options = hotkeyOptions({ shortcut: TOGGLE_PANEL_SHORTCUT, ...enabled });
    expect(options.enableOnFormTags).toBe(true);
    expect(options.enableOnContentEditable).toBe(true);
  });

  it("leaves Cmd-I's default alone", () => {
    expect(hotkeyOptions({ shortcut: ASK_AI_SHORTCUT, ...enabled }).preventDefault).toBe(false);
  });
});

describe("hotkeyOptions", () => {
  it("defaults to leaving the browser default alone", () => {
    expect(hotkeyOptions({ shortcut: { key: "k" }, ...enabled })).toEqual({
      enabled: true,
      enableOnFormTags: false,
      enableOnContentEditable: false,
      preventDefault: false,
    });
  });

  // The library calls preventDefault before it checks `enabled`.
  it("does not prevent the default while the shortcut is disabled", () => {
    expect(
      hotkeyOptions({ shortcut: TOGGLE_PANEL_SHORTCUT, isEnabled: false }).preventDefault
    ).toBe(false);
  });

  it("lets the call site turn on input elements for a shortcut that did not", () => {
    const options = hotkeyOptions({
      shortcut: { key: "k" },
      isEnabled: true,
      enabledOnInputElements: true,
    });
    expect(options.enableOnFormTags).toBe(true);
  });

  it("survives an undefined shortcut", () => {
    expect(hotkeyOptions({ shortcut: undefined, isEnabled: false })).toEqual({
      enabled: false,
      enableOnFormTags: false,
      enableOnContentEditable: false,
      preventDefault: false,
    });
  });
});
