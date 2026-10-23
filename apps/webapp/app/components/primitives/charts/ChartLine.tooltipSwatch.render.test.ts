import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

type ItemColor = (item: { dataKey?: unknown; value?: unknown }) => string | undefined;
let captured: { itemColor?: ItemColor; payload?: { dataKey: string }[] } = {};

vi.mock("./Chart", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChartTooltipContent: (props: typeof captured) => {
    captured = props;
    return null;
  },
}));

import { OverlayFilteredTooltip } from "./ChartLine";

const WARN = "var(--color-warning)";

function render(direction: "above" | "below" = "above") {
  renderToStaticMarkup(
    createElement(OverlayFilteredTooltip, {
      active: true,
      overlayThreshold: 3,
      overlayDirection: direction,
      payload: [
        { dataKey: "a", value: 5 },
        { dataKey: "b", value: 1 },
        { dataKey: "__warningOverlay_a", value: 5 },
      ],
    })
  );
  return captured.itemColor!;
}

describe("overlay tooltip swatches", () => {
  it("highlights only the series whose own value crosses the threshold", () => {
    const itemColor = render();
    expect(itemColor({ dataKey: "a", value: 5 })).toBe(WARN);
    expect(itemColor({ dataKey: "b", value: 1 })).toBeUndefined();
    expect(captured.payload!.map((p) => p.dataKey)).toEqual(["a", "b"]);
  });

  it("honours a below-threshold operator per series", () => {
    const itemColor = render("below");
    expect(itemColor({ dataKey: "a", value: 5 })).toBeUndefined();
    expect(itemColor({ dataKey: "b", value: 1 })).toBe(WARN);
  });
});
