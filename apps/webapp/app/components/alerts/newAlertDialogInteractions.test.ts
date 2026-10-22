// @vitest-environment jsdom
//
// Mirrors the route's Dialog/DialogContent/Select wiring to catch close-signal
// mis-targeting between the Ariakit select popover and the Radix dialog.
// Uses a ref to track the select's open state (simulating the browser's
// synchronous update that defeats a state-only guard).
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { Select, SelectItem } from "~/components/primitives/Select";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (globalThis as any).PointerEvent === "undefined") {
  (globalThis as any).PointerEvent = class extends Event {};
}
if (typeof (HTMLElement.prototype as any).hasPointerCapture !== "function") {
  (HTMLElement.prototype as any).hasPointerCapture = () => false;
}
if (typeof (HTMLElement.prototype as any).scrollIntoView !== "function") {
  (HTMLElement.prototype as any).scrollIntoView = () => {};
}

let selectOpenSync = false;

function NewAlertDialogHarness({ onOuterClose }: { onOuterClose: () => void }) {
  const [operatorSelectOpen, setOperatorSelectOpen] = useState(false);

  const wrappedSetOpen = (open: boolean) => {
    // eslint-disable-next-line react/no-direct-mutation-state
    selectOpenSync = open; // eslint-disable-line
    setOperatorSelectOpen(open);
  };

  const select = createElement(
    Select,
    {
      defaultValue: ">",
      placeholder: "Operator",
      variant: "tertiary/medium",
      open: operatorSelectOpen,
      setOpen: wrappedSetOpen,
      items: [
        { label: ">", value: ">" },
        { label: "<", value: "<" },
      ],
    },
    (matches: { label: string; value: string }[]) =>
      matches?.map((o) => createElement(SelectItem, { key: o.value, value: o.value }, o.label))
  );

  const saveButton = createElement(
    Button,
    { type: "submit", variant: "primary/medium", name: "action", value: "create" },
    "Save"
  );

  const form = createElement("form", { method: "post" }, select, saveButton);

  const dialogContent = createElement(
    DialogContent,
    null,
    createElement(DialogHeader, null, "New alert"),
    form
  );

  const dialog = createElement(
    Dialog,
    {
      open: true,
      onOpenChange: (o: boolean) => {
        if (!o && selectOpenSync) {
          wrappedSetOpen(false);
          return;
        }
        if (!o) onOuterClose();
      },
    },
    dialogContent
  );

  const withShortcuts = createElement(ShortcutsProvider, null, dialog);

  return createElement(OperatingSystemContextProvider, { platform: "mac" }, withShortcuts);
}

function renderNewAlertDialog(root: Root, onOuterClose: () => void) {
  act(() => {
    root.render(createElement(NewAlertDialogHarness, { onOuterClose }));
  });
}

function dispatchEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("new-alert dialog primitive wiring", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    selectOpenSync = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("associates the Save button with the surrounding form", () => {
    renderNewAlertDialog(root, () => {});

    const formEl = document.querySelector("form");
    const saveButtonEl = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Save"
    ) as HTMLButtonElement | undefined;

    expect(formEl).not.toBeNull();
    expect(saveButtonEl).toBeDefined();
    expect(saveButtonEl?.getAttribute("type")).toBe("submit");
    expect(saveButtonEl?.form).toBe(formEl);
  });

  it("renders the operator select's bound default value, not its placeholder", () => {
    renderNewAlertDialog(root, () => {});

    const trigger = document.querySelector('button[aria-haspopup="listbox"]');
    const triggerText = trigger?.textContent ?? document.body.textContent ?? "";

    expect(triggerText).toContain(">");
    expect(triggerText).not.toContain("Operator");
  });

  it("Escape while select open leaks to the dialog when the guard reads a ref", () => {
    const onOuterClose = vi.fn();
    renderNewAlertDialog(root, onOuterClose);

    const trigger = document.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
    act(() => {
      trigger.click();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    dispatchEscape();

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onOuterClose).toHaveBeenCalled();
  });
});
