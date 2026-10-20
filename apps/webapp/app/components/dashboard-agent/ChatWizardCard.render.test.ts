// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { conditionSummary, conditionSuggestionChips } from "./alert-creation/flow-state";
import {
  ChatWizardCard,
  InputRow,
  type ChatWizardCardProps,
  type ChatWizardStep,
} from "./ChatWizardCard";

vi.mock("~/components/alerts/AlertChannelsDialog", () => ({
  AlertChannelsDialog: () =>
    createElement("div", { role: "dialog", "data-channels": "" }, "Ops webhook"),
}));

const option = (id: string) => ({ id, label: `Option ${id}` });

const steps: ChatWizardStep[] = [
  { id: "a", question: "First question?", options: [option("a1"), option("a2")] },
  {
    id: "b",
    question: "Where should the path sit?",
    options: [option("b1"), option("b2"), option("b3")],
  },
  { id: "c", question: "Last question?", options: [option("c1"), option("c2")] },
];

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function tree(props: ChatWizardCardProps, onPanelClose?: () => void) {
  return createElement(
    OperatingSystemContextProvider,
    { platform: "mac" },
    createElement(
      ShortcutsProvider,
      null,
      createElement(
        "div",
        {
          "data-agent-panel": "visible",
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Escape" && !e.defaultPrevented) onPanelClose?.();
          },
        },
        createElement(ChatWizardCard, props)
      )
    )
  );
}

function render(overrides: Partial<ChatWizardCardProps> = {}, onPanelClose?: () => void) {
  const props: ChatWizardCardProps = {
    steps,
    stepIndex: 1,
    onStepChange: vi.fn(),
    onSelect: vi.fn(),
    onSkip: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(tree(props, onPanelClose)));
  return { props, el: container };
}

function rerender(props: ChatWizardCardProps) {
  act(() => root!.render(tree(props)));
}

const button = (el: HTMLElement, label: string) =>
  el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

describe("ChatWizardCard", () => {
  it("shows the question, position, unnumbered options and skip", () => {
    const { el } = render();
    const text = el.textContent ?? "";
    expect(text).toContain("Where should the path sit?");
    expect(text).toContain("2 of 3");
    const rows = Array.from(el.querySelectorAll("li > button:only-child"))
      .map((n) => n.textContent)
      .filter((label) => label !== "Skip");
    expect(rows).toEqual(["Option b1", "Option b2", "Option b3"]);
    expect(text).not.toContain("Something else");
    expect(text).toContain("Skip");
  });

  it("renders a custom input inline and submits it on Enter", () => {
    const onSubmit = vi.fn();
    const custom = {
      id: "v",
      open: true,
      ariaLabel: "Custom answer",
      placeholder: "when queue depth gets higher than…",
      parse: (text: string) => text.trim() || undefined,
      onSubmit,
    };
    const { el } = render({ steps: [{ ...steps[1]!, allowSkip: false, custom }], stepIndex: 0 });
    expect(el.textContent).not.toContain("Something else");
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Custom answer"]')!;
    expect(input.placeholder).toBe("");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "worker-*");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith("worker-*");
  });

  it("clears a committed custom value on blur, not while typing", () => {
    const onClear = vi.fn();
    const custom = {
      id: "v",
      open: true,
      numeric: true,
      current: "137",
      ariaLabel: "Custom answer",
      parse: (text: string) => (Number(text) >= 0 && text.trim() ? text.trim() : undefined),
      onSubmit: vi.fn(),
      onClear,
    };
    const { el } = render({ steps: [{ ...steps[1]!, allowSkip: false, custom }], stepIndex: 0 });
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Custom answer"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onClear).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("steps back and forward by one", () => {
    const { el, props } = render({
      steps: steps.map((step) => ({ ...step, selected: [`${step.id}1`] })),
    });
    act(() => button(el, "Previous question").click());
    act(() => button(el, "Next question").click());
    expect(props.onStepChange).toHaveBeenNthCalledWith(1, 0);
    expect(props.onStepChange).toHaveBeenNthCalledWith(2, 2);
  });

  it("disables previous on the first step and next on the last", () => {
    const answered = steps.map((step) => ({ ...step, selected: [`${step.id}1`] }));
    const first = render({ steps: answered, stepIndex: 0 });
    expect(button(first.el, "Previous question").disabled).toBe(true);
    expect(button(first.el, "Next question").disabled).toBe(false);
    act(() => root!.unmount());
    root = undefined;

    const unanswered = render({ stepIndex: 0 });
    expect(button(unanswered.el, "Next question").disabled).toBe(true);
    act(() => root!.unmount());
    root = undefined;

    const last = render({ stepIndex: 2 });
    expect(button(last.el, "Previous question").disabled).toBe(false);
    expect(button(last.el, "Next question").disabled).toBe(true);
  });

  it("leaves digits and Escape to a text field outside the card", () => {
    const { el, props } = render();
    const input = document.createElement("textarea");
    el.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape from outside the agent panel", () => {
    const { props } = render();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    outside.remove();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Escape on the body closes the card", () => {
    const { props } = render();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the card after a pick", () => {
    const { el } = render();
    act(() => el.querySelector<HTMLButtonElement>("li > button")!.click());
    expect(document.activeElement).toBe(el.querySelector("[role=dialog]"));
  });

  it("Escape from the agent composer closes the card, not the panel", () => {
    const onPanelClose = vi.fn();
    const { el, props } = render({}, onPanelClose);
    const composer = document.createElement("textarea");
    composer.setAttribute("data-agent-composer", "");
    el.querySelector("[data-agent-panel]")!.appendChild(composer);
    composer.focus();
    act(() => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(onPanelClose).not.toHaveBeenCalled();
  });

  it("Escape from a focused row closes the card, not the panel", () => {
    const onPanelClose = vi.fn();
    const { el, props } = render({}, onPanelClose);
    const row = el.querySelector<HTMLButtonElement>("li > button")!;
    row.focus();
    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(onPanelClose).not.toHaveBeenCalled();
  });

  it("ignores number and arrow keys from outside the agent panel", () => {
    const { props } = render();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const events = ["1", "ArrowDown"].map(
      (key) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
    act(() => events.forEach((event) => outside.dispatchEvent(event)));
    outside.remove();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onStepChange).not.toHaveBeenCalled();
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false]);
  });

  it("handles number and arrow keys from inside the card", () => {
    const { props, el } = render();
    const row = el.querySelector<HTMLButtonElement>("li > button")!;
    const down = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true })
      );
      row.dispatchEvent(down);
    });
    expect(props.onSelect).toHaveBeenCalledWith("b", "b1");
    expect(down.defaultPrevented).toBe(true);
  });

  it("selects the option matching a number key", () => {
    const { props } = render();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    expect(props.onSelect).toHaveBeenCalledWith("b", "b2");
  });

  it("scrolls a long option list under a pinned header", () => {
    const options = Array.from({ length: 12 }, (_, i) => option(`o${i}`));
    const { el } = render({
      steps: [{ id: "long", question: "Pick one?", options, multiSelect: true, selected: ["o0"] }],
      stepIndex: 0,
      maxHeight: 200,
    });
    const dialog = el.querySelector<HTMLElement>("[role=dialog]")!;
    const list = dialog.querySelector("ul")!;
    expect(dialog.style.maxHeight).toBe("200px");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.textContent).not.toContain("Pick one?");
    expect(dialog.textContent).toContain("Pick one?");
    const done = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "Done"
    )!;
    expect(list.contains(done)).toBe(false);
  });

  it("hides Skip when allowSkip is false", () => {
    const { el } = render({ steps: [{ ...steps[1]!, allowSkip: false }], stepIndex: 0 });
    expect(el.textContent).not.toContain("Skip");
  });

  it("multi-select toggles rows and Done confirms", () => {
    const onConfirm = vi.fn();
    const multi = { id: "m", question: "Where?", options: [option("x")], multiSelect: true };
    const { el, props } = render({
      steps: [{ ...multi, selected: ["x"] }],
      stepIndex: 0,
      onConfirm,
    });
    const row = el.querySelector<HTMLButtonElement>("li > button")!;
    expect(row.getAttribute("aria-pressed")).toBe("true");
    act(() => row.click());
    expect(props.onSelect).toHaveBeenCalledWith("m", "x");
    const done = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Done")!;
    act(() => done.click());
    expect(onConfirm).toHaveBeenCalledWith("m");
  });
});

describe("ChatWizardCard input rows", () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  // Mutation: committing on Escape or not resetting the draft fails this.
  it("Escape restores the committed value and keeps the card open", () => {
    const onSubmit = vi.fn();
    const custom = {
      id: "v",
      open: true,
      ariaLabel: "Custom answer",
      current: "5",
      parse: (text: string) => text.trim() || undefined,
      onSubmit,
    };
    const { el, props } = render({ steps: [{ ...steps[1]!, custom }], stepIndex: 0 });
    const input = () => el.querySelector<HTMLInputElement>('input[aria-label="Custom answer"]')!;
    type(input(), "9");
    input().focus();
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(input().value).toBe("5");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  // Mutation: confirming an unchanged value resubmits instead of moving on.
  it("confirming the committed value moves to the next step", () => {
    const onSubmit = vi.fn();
    const custom = {
      id: "v",
      open: true,
      ariaLabel: "Custom answer",
      current: "5",
      parse: (text: string) => text.trim() || undefined,
      onSubmit,
    };
    const { el, props } = render({
      steps: [{ ...steps[1]!, custom, selected: ["b1"] }, steps[2]!],
      stepIndex: 0,
    });
    const row = el.querySelector('input[aria-label="Custom answer"]')!.closest("li")!;
    expect(row.querySelector('[aria-label="Selected"]')).not.toBeNull();
    act(() => button(el, "Confirm").click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(props.onStepChange).toHaveBeenCalledWith(1);
  });
});

describe("ChatWizardCard custom input errors", () => {
  it("clears the error once an invalid value is deleted", () => {
    const custom = {
      id: "v",
      open: true,
      ariaLabel: "Custom answer",
      numeric: true,
      rule: { min: 0 },
      parse: (text: string) => (Number(text) >= 0 && text.trim() ? text : undefined),
      onSubmit: vi.fn(),
    };
    const { el } = render({ steps: [{ ...steps[1]!, allowSkip: false, custom }], stepIndex: 0 });
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Custom answer"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = (value: string) =>
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("-5");
    expect(el.textContent).toContain("Must be greater than 0");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    type("");
    expect(el.textContent).not.toContain("Enter a value");
    expect(el.textContent).not.toContain("Must be greater than 0");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});

describe("ChatWizardCard option info tooltips", () => {
  const described: ChatWizardStep[] = [
    {
      id: "s",
      question: "What about runs?",
      options: [
        { id: "x", label: "Run volume", description: "Counts runs per window" },
        { id: "y", label: "Failure rate", description: "Share of failed runs" },
      ],
    },
    { id: "t", question: "Next?", options: [option("t1")] },
  ];
  const tip = () => document.body.textContent?.includes("Counts runs per window") ?? false;
  const info = (el: HTMLElement) => button(el, "About Run volume");
  const row = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>("li > button")).find(
      (b) => b.textContent === "Run volume"
    )!;
  const hover = (target: Element) =>
    act(() => {
      target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Mutation: making the whole row the trigger opens it from the row.
  it("opens from the icon after 500ms, not from the row", () => {
    const { el } = render({ steps: described, stepIndex: 0 });
    expect(row(el).getAttribute("data-state")).toBeNull();
    hover(row(el));
    act(() => vi.advanceTimersByTime(1000));
    expect(tip()).toBe(false);
    hover(info(el));
    act(() => vi.advanceTimersByTime(499));
    expect(tip()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(tip()).toBe(true);
    const content = Array.from(document.querySelectorAll("[data-side]")).find((n) =>
      n.textContent?.includes("Counts runs per window")
    )!;
    expect(content.className).toContain("max-w-[300px]");
  });

  // Mutation: dropping disableHoverableContent keeps it open over the list after the pointer leaves.
  it("closes as soon as the pointer leaves the icon and on step change", () => {
    const { el, props } = render({
      steps: [{ ...described[0]!, selected: ["x"] }, described[1]!],
      stepIndex: 0,
    });
    hover(info(el));
    act(() => vi.advanceTimersByTime(500));
    expect(tip()).toBe(true);
    const at = { clientX: 1, clientY: 1, relatedTarget: document.body };
    act(() => {
      info(el).dispatchEvent(new MouseEvent("pointerout", { ...at, bubbles: true }));
      info(el).dispatchEvent(new MouseEvent("pointerleave", at));
    });
    expect(tip()).toBe(false);

    hover(info(el));
    act(() => vi.advanceTimersByTime(500));
    expect(tip()).toBe(true);
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
    });
    expect(props.onStepChange).toHaveBeenCalledWith(1);
    rerender({ ...props, stepIndex: 1 });
    expect(tip()).toBe(false);
  });

  // Mutation: rendering the info icon after the row puts it after the checkmark.
  it("puts the info icon before the checkmark", () => {
    const { el } = render({ steps: [{ ...described[0]!, selected: ["x"] }], stepIndex: 0 });
    const check = row(el).querySelector('[aria-label="Selected"]')!;
    expect(info(el).compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is focusable and opens on keyboard focus", () => {
    const { el } = render({ steps: described, stepIndex: 0 });
    expect(info(el).tabIndex).toBe(0);
    act(() => info(el).focus());
    expect(tip()).toBe(true);
  });
});

describe("ChatWizardCard list fade", () => {
  const size = (list: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop = 0) => {
    Object.defineProperty(list, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: clientHeight, configurable: true });
    Object.defineProperty(list, "scrollTop", { value: scrollTop, configurable: true });
    act(() => {
      list.dispatchEvent(new Event("scroll"));
    });
  };

  // Mutation: rendering the fade unconditionally fails the first and last checks.
  it("shows a bottom fade only while the list overflows below", () => {
    const { el } = render();
    const list = el.querySelector<HTMLElement>("[role=dialog] ul")!;
    const fade = () => el.querySelector('[data-testid="scroll-fade"]');
    expect(fade()).toBeNull();
    size(list, 500, 200);
    expect(fade()).not.toBeNull();
    size(list, 500, 200, 300);
    expect(fade()).toBeNull();
  });
});

describe("ChatWizardCard numbers", () => {
  const custom = {
    id: "v",
    open: true,
    ariaLabel: "Threshold",
    numeric: true,
    parse: (text: string) => (text.trim() && Number.isFinite(Number(text)) ? text : undefined),
    onSubmit: vi.fn(),
  };

  // Mutation: a text-type input keeps "abc".
  it("numeric input rejects letters", () => {
    const { el } = render({ steps: [{ ...steps[1]!, custom }], stepIndex: 0 });
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Threshold"]')!;
    expect(input.inputMode).toBe("decimal");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "abc");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("");
    const key = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(key);
    });
    expect(key.defaultPrevented).toBe(true);
  });

  // Mutation: a raw template label renders "1000ms".
  it("renders 1000 as 1,000 with tabular figures", () => {
    const options = conditionSuggestionChips("runs.duration_p95").map((chip) => ({
      id: chip.value,
      label: chip.label,
    }));
    const { el } = render({ steps: [{ id: "c", question: "Threshold?", options }], stepIndex: 0 });
    const chip = Array.from(el.querySelectorAll<HTMLButtonElement>("li > button")).find((b) =>
      b.textContent?.startsWith("1,000")
    )!;
    expect(chip.textContent).toBe("1,000ms");
    expect(chip.className).toContain("tabular-nums");
    expect(
      conditionSummary({ area: "runs", what: "runs.duration_p95", condition: "1000" })
    ).toContain("1,000ms");
  });
});

describe("ChatWizardCard custom row", () => {
  const custom = {
    id: "v",
    ariaLabel: "Threshold",
    placeholder: "hint",
    numeric: true,
    rule: { min: 1, max: 100 },
    parse: (text: string) => (Number(text) >= 1 && Number(text) <= 100 ? text : undefined),
    onSubmit: vi.fn(),
  };
  const rowButtons = (el: HTMLElement) =>
    Array.from(el.querySelectorAll("li > button:only-child")).map((b) => b.textContent);
  const input = (el: HTMLElement) =>
    el.querySelector<HTMLInputElement>('input[aria-label="Threshold"]');
  const type = (el: HTMLElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(el),
        value
      );
      input(el)!.dispatchEvent(new Event("input", { bubbles: true }));
    });

  // Mutation: the input renders up front instead of a trailing Custom row.
  it("shows a trailing Custom row that becomes the input in place, without a placeholder", () => {
    const { el } = render({ steps: [{ ...steps[1]!, custom }], stepIndex: 0 });
    expect(input(el)).toBeNull();
    expect(rowButtons(el)).toEqual(["Option b1", "Option b2", "Option b3", "Custom", "Skip"]);
    const customRow = Array.from(el.querySelectorAll<HTMLButtonElement>("li > button")).find(
      (b) => b.textContent === "Custom"
    )!;
    act(() => customRow.click());
    expect(input(el)!.placeholder).toBe("");
    expect(input(el)!.className).toContain("border-0 outline-0 focus:shadow-none");
    expect(rowButtons(el)).not.toContain("Custom");
  });

  // Mutation: the generic "Enter a valid value" comes back for ranged numbers.
  it("explains the violated range", () => {
    const { el } = render({
      steps: [{ ...steps[1]!, custom: { ...custom, open: true } }],
      stepIndex: 0,
    });
    type(el, "500");
    expect(el.textContent).toContain("Must be between 1 and 100");
    expect(el.textContent).not.toContain("Enter a valid value");
  });

  // Mutation: the description goes back inside the title column.
  it("renders the description as its own full-width line of the header", () => {
    const { el } = render({
      steps: [{ ...steps[1]!, description: "The alert stops checking once it expires." }],
      stepIndex: 0,
    });
    const description = Array.from(el.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("stops checking")
    )!;
    expect(description.parentElement!.className).toContain("px-3 pb-2 pt-3");
    expect(description.className).toContain("w-full");
  });

  // Mutation: the entity-backed option row stays next to the dropdown.
  it("replaces the entity option row with the dropdown", () => {
    const step: ChatWizardStep = {
      id: "scope",
      question: "Which queues?",
      options: [option("all"), option("queue")],
      entityOption: "queue",
      selected: ["all"],
      entity: {
        id: "queue",
        ariaLabel: "Queue",
        placeholder: "Select a queue",
        options: [{ id: "q1", label: "q1" }],
        onSelect: vi.fn(),
      },
    };
    const { el } = render({ steps: [step], stepIndex: 0 });
    expect(rowButtons(el)).toContain("Option all");
    expect(rowButtons(el)).not.toContain("Option queue");
    expect(el.textContent).toContain("Select a queue");
  });

  it("keeps a fixed dropdown height regardless of result count", () => {
    const step: ChatWizardStep = {
      id: "scope",
      question: "Which queues?",
      options: [option("all"), option("queue")],
      entityOption: "queue",
      selected: ["queue"],
      entity: {
        id: "queue",
        ariaLabel: "Queue",
        placeholder: "Select a queue",
        options: [{ id: "q1", label: "q1" }],
        onSelect: vi.fn(),
      },
    };
    const { el } = render({ steps: [step], stepIndex: 0 });
    act(() => {
      el.querySelector<HTMLElement>('[aria-label="Queue"]')!.click();
    });
    const popover = document.querySelector<HTMLElement>('[class*="popover-available-height"]');
    expect(popover?.className.split(" ")).toContain(
      "h-[min(280px,var(--popover-available-height))]"
    );
  });
});

describe("ChatWizardCard polish", () => {
  const numeric = {
    id: "v",
    open: true,
    ariaLabel: "Threshold",
    numeric: true,
    unit: "runs",
    rule: { min: 0 },
    parse: (text: string) => (text.trim() && Number(text) >= 0 ? text : undefined),
    onSubmit: vi.fn(),
  };
  const inputOf = (el: HTMLElement) =>
    el.querySelector<HTMLInputElement>('input[aria-label="Threshold"]')!;

  it("fails if 0 is accepted", () => {
    const { el } = render({
      steps: [{ ...steps[1]!, allowSkip: false, custom: numeric }],
      stepIndex: 0,
    });
    const input = inputOf(el);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "0");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.textContent).toContain("Must be greater than 0");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("fails if allowZero rejects 0 or accepts negatives", () => {
    const { el } = render({
      steps: [
        {
          ...steps[1]!,
          allowSkip: false,
          custom: { ...numeric, rule: { min: 0, allowZero: true } },
        },
      ],
      stepIndex: 0,
    });
    const input = inputOf(el);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = (value: string) =>
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("0");
    expect(el.textContent).not.toContain("Must be greater than 0");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    type("-1");
    expect(el.textContent).toContain("Must be at least 0");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("fails if the unit is hidden while the input is empty", () => {
    const { el } = render({
      steps: [{ ...steps[1]!, allowSkip: false, custom: numeric }],
      stepIndex: 0,
    });
    expect(inputOf(el).closest("li")!.textContent).toContain("runs");
  });

  it("fails if card inputs keep a focus ring", () => {
    const { el } = render({
      steps: [{ ...steps[1]!, allowSkip: false, custom: numeric }],
      stepIndex: 0,
    });
    expect(inputOf(el).className).toContain("focus:ring-0");
  });

  it("fails if the card is not rounded-lg", () => {
    const { el } = render();
    expect(el.querySelector('[role="dialog"]')!.className).toContain("rounded-lg");
  });

  it("fails if past date yields no message", () => {
    const custom = {
      id: "d",
      open: true,
      type: "date" as const,
      ariaLabel: "Expiry",
      current: new Date(Date.now() - 86_400_000).toISOString(),
      parse: (text: string) => (new Date(text).getTime() > Date.now() ? text : undefined),
      onSubmit: vi.fn(),
    };
    const { el } = render({ steps: [{ ...steps[1]!, allowSkip: false, custom }], stepIndex: 0 });
    expect(el.textContent).toContain("Must be in the future");
  });
});

describe("ChatWizardCard until row", () => {
  const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();
  const dateInput = (extra: object = {}) => ({
    id: "d",
    open: true,
    type: "date" as const,
    ariaLabel: "Expiry",
    parse: (text: string) => (new Date(text).getTime() > Date.now() ? text : undefined),
    onSubmit: vi.fn(),
    ...extra,
  });
  const untilStep = (custom?: ReturnType<typeof dateInput>): ChatWizardStep => ({
    id: "e",
    question: "Until?",
    options: [option("e1"), option("e2"), { id: "until", label: "Until…" }],
    customOption: "until",
    custom,
  });
  const type = (el: HTMLElement, segment: string, digits: string) => {
    const target = el.querySelector<HTMLElement>(`[data-segment-type="${segment}"]`)!;
    for (const data of digits) {
      act(() => {
        target.dispatchEvent(
          new InputEvent("beforeinput", { data, bubbles: true, cancelable: true })
        );
      });
    }
  };

  // Mutation: appending the date row, or keeping the second span at full height, fails.
  it("fails if the date row is added instead of replacing Until or its segments overflow", () => {
    const closed = render({ steps: [untilStep()], stepIndex: 0 }).el;
    const before = closed.querySelectorAll("ul > li").length;
    act(() => root!.unmount());
    container!.remove();
    const { el } = render({ steps: [untilStep(dateInput())], stepIndex: 0 });
    expect(el.querySelectorAll("ul > li").length).toBe(before);
    expect(el.textContent).not.toContain("Until…");
    for (const segment of el.querySelectorAll<HTMLElement>("[data-segment-type]")) {
      const full = Array.from(segment.children).filter(
        (child) => (child as HTMLElement).style.height !== "0px"
      );
      expect(full.length).toBeLessThanOrEqual(1);
    }
    expect(el.querySelector('[aria-label="Expiry"]')!.outerHTML).not.toContain("w-24");
  });

  // Mutation: removing the beforeinput range check stores month 13 as March.
  it("fails if 13 in the month segment is accepted", () => {
    const onSubmit = vi.fn();
    const { el } = render({
      steps: [untilStep(dateInput({ current: future(), onSubmit }))],
      stepIndex: 0,
    });
    type(el, "month", "13");
    expect(el.textContent).toContain("Enter a valid date");
    expect(button(el, "Confirm").disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Mutation: re-adding an upper bound on the expiry rejects year 9999.
  it("a far-future expiry is accepted", () => {
    const onSubmit = vi.fn();
    const { el } = render({
      steps: [untilStep(dateInput({ current: future(), onSubmit }))],
      stepIndex: 0,
    });
    type(el, "month", "09");
    type(el, "day", "09");
    type(el, "year", "9999");
    type(el, "hour", "09");
    type(el, "minute", "09");
    expect(el.textContent).not.toContain("Must be");
    expect(button(el, "Confirm").disabled).toBe(false);
    act(() => button(el, "Confirm").click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toContain("9999");
  });

  // Mutation: dropping borderless or using variant="row" fails.
  it("fails if the active expiry step is not the borderless small date field", () => {
    const { el } = render({
      steps: [untilStep(dateInput({ current: future() }))],
      stepIndex: 0,
    });
    const segment = el.querySelector<HTMLElement>('[data-segment-type="day"]')!;
    expect(segment.className).toContain("text-xs");
    expect(segment.className).not.toContain("text-sm");
    expect(segment.parentElement!.className).not.toContain("border");
  });

  // Mutation: clearing on every keystroke instead of only on blur or Enter.
  it("clears a committed expiry only on blur, not while editing to a past date", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T10:00:00Z") });
    try {
      const onClear = vi.fn();
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root!.render(
          createElement(InputRow, {
            input: dateInput({ current: "2026-10-08T17:00:00.000Z", onClear }),
            onValidity: vi.fn(),
          })
        )
      );
      const month = container.querySelector<HTMLElement>('[data-segment-type="month"]')!;
      act(() => {
        month.focus();
        month.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(container.textContent).toContain("Must be in the future");
      expect(onClear).not.toHaveBeenCalled();
      act(() => month.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(onClear).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts 12 in the month segment", () => {
    const { el } = render({
      steps: [untilStep(dateInput({ current: future() }))],
      stepIndex: 0,
    });
    type(el, "month", "12");
    expect(el.textContent).not.toContain("Enter a valid date");
  });
});

describe("ChatWizardCard focus", () => {
  // Mutation: removing autoFocus on the first field leaves focus on the body.
  it("fails if entering a step with fields does not focus the first input", () => {
    const field = (id: string) => ({
      id,
      ariaLabel: id,
      numeric: true,
      parse: (t: string) => t || undefined,
      onSubmit: vi.fn(),
    });
    const { el } = render({
      steps: [{ id: "h", question: "When?", options: [], fields: [field("a"), field("b")] }],
      stepIndex: 0,
    });
    expect(document.activeElement).toBe(el.querySelector('[aria-label="a"]'));
  });
});

describe("ChatWizardCard trailing icon", () => {
  // Mutation: dropping trailingIcon renders the arrow.
  it("fails if a row ignores its trailing icon", () => {
    const Marker = (props: { className?: string }) =>
      createElement("svg", { ...props, "data-marker": "dots" });
    const { el } = render({
      steps: [{ id: "n", question: "Who?", options: [{ ...option("n1"), trailingIcon: Marker }] }],
      stepIndex: 0,
    });
    const row = el.querySelector<HTMLButtonElement>("li > button")!;
    expect(row.querySelectorAll("svg")).toHaveLength(1);
    expect(row.querySelector("[data-marker=dots]")).not.toBeNull();
  });

  it("renders no trailing icon when trailingIcon is null", () => {
    const { el } = render({
      steps: [{ id: "n", question: "Who?", options: [{ ...option("n1"), trailingIcon: null }] }],
      stepIndex: 0,
    });
    expect(el.querySelector("li > button")!.querySelectorAll("svg")).toHaveLength(0);
  });

  it("opens the channels dialog from the description action", () => {
    const description = "Missing one? Check the channels list.";
    const { el } = render({
      steps: [{ ...steps[1]!, description, descriptionAction: { label: "channels list" } }],
      stepIndex: 0,
    });
    expect(el.textContent).toContain(description);
    expect(el.querySelector("[data-channels]")).toBeNull();
    const action = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "channels list"
    )!;
    act(() => action.click());
    expect(el.querySelector("[data-channels]")?.textContent).toBe("Ops webhook");
  });
});
