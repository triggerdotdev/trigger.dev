// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateField } from "./DateField";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function typeHour(defaultValue: Date, digits: string, hourCycle: 12 | 24) {
  const onInvalidInput = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(DateField, {
        label: "When",
        defaultValue,
        granularity: "minute",
        hourCycle,
        onInvalidInput,
      })
    )
  );
  const target = container.querySelector<HTMLElement>('[data-segment-type="hour"]')!;
  for (const data of digits) {
    act(() => {
      target.dispatchEvent(
        new InputEvent("beforeinput", { data, bubbles: true, cancelable: true })
      );
    });
  }
  act(() => root!.unmount());
  container.remove();
  root = undefined;
  return onInvalidInput;
}

describe("DateField hour input", () => {
  it("accepts 12 in AM and 05 in PM in 12h mode", () => {
    expect(typeHour(new Date(2030, 5, 1, 9, 0), "12", 12)).not.toHaveBeenCalled();
    expect(typeHour(new Date(2030, 5, 1, 15, 0), "05", 12)).not.toHaveBeenCalled();
  });

  it("rejects 25 in 24h mode", () => {
    expect(typeHour(new Date(2030, 5, 1, 9, 0), "25", 24)).toHaveBeenCalled();
  });
});
