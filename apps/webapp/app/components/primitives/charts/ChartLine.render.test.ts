import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartProvider } from "./ChartContext";
import { ChartLineRenderer, overlayDotVisible, type ChartLineRendererProps } from "./ChartLine";

const BASE = "var(--color-queues-chart)";
const WARN = "var(--color-warning)";

function render(
  values: number[],
  warningOverlay: ChartLineRendererProps["warningOverlay"],
  line: Partial<ChartLineRendererProps> = { lineType: "linear" }
) {
  const html = renderToStaticMarkup(
    createElement(
      ChartProvider,
      {
        config: { value: { label: "Value", color: BASE } },
        data: values.map((value, i) => ({ bucket: i, value })),
        dataKey: "bucket",
        series: ["value"],
        showLegend: true,
      },
      createElement(ChartLineRenderer, {
        ...line,
        showDots: false,
        warningOverlay,
        width: 400,
        height: 200,
      })
    )
  );
  const paths = (color: string) =>
    [...html.matchAll(/<path[^>]*recharts-line-curve[^>]*>/g)]
      .map((m) => m[0])
      .filter((p) => p.includes(`stroke="${color}"`))
      .map((p) => /\sd="([^"]*)"/.exec(p)?.[1] ?? "")
      .filter((d) => d.length > 0);
  return { html, base: paths(BASE), warn: paths(WARN) };
}

const segments = (d: string) => d.split("M").filter(Boolean).length;

describe("ChartLine warning overlay", () => {
  it("leaves a gap in the base line where the overlay is drawn", () => {
    const { base, warn } = render([1, 1, 1, 10, 1, 1, 1], { threshold: 5 });
    expect(warn).toHaveLength(1);
    expect(base).toHaveLength(1);
    expect(segments(base[0]!)).toBe(2);
  });

  it("draws no overlay when below and every value is above the threshold", () => {
    const { base, warn } = render([50, 50, 50], { threshold: 10, direction: "below" });
    expect(warn).toHaveLength(0);
    expect(segments(base[0]!)).toBe(1);
  });

  it("draws the overlay when below and values dip under the threshold", () => {
    const { warn } = render([50, 50, 5, 50, 50], { threshold: 10, direction: "below" });
    expect(warn).toHaveLength(1);
  });
});

describe("ChartLine multi-series warning overlay", () => {
  it("draws a warning segment for every series over the threshold", () => {
    const html = renderToStaticMarkup(
      createElement(
        ChartProvider,
        {
          config: { a: { label: "A", color: "#aaaaaa" }, b: { label: "B", color: "#bbbbbb" } },
          data: [1, 1, 10, 1, 1].map((v, i) => ({ bucket: i, a: v, b: v * 2 })),
          dataKey: "bucket",
          series: ["a", "b"],
          showLegend: true,
        },
        createElement(ChartLineRenderer, {
          lineType: "linear",
          showDots: false,
          warningOverlay: { threshold: 5 },
          width: 400,
          height: 200,
        })
      )
    );
    const curves = [...html.matchAll(/<path[^>]*recharts-line-curve[^>]*>/g)].map((m) => m[0]);
    const drawn = (color: string) =>
      curves.filter((p) => p.includes(`stroke="${color}"`) && /\sd="[^"]+"/.test(p));
    expect(drawn(WARN)).toHaveLength(2);
    expect(drawn("#aaaaaa")).toHaveLength(1);
    expect(drawn("#bbbbbb")).toHaveLength(1);
  });
});

describe("ChartLine step warning overlay", () => {
  const points = (d: string) =>
    [...d.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);

  it("colours the drop, the low run and the rise but not the healthy plateau", () => {
    const { base, warn } = render(
      [1, 1, 0, 0, 1],
      { threshold: 0.5, direction: "below" },
      { lineType: "stepAfter", xAxisProps: { type: "number", domain: ["dataMin", "dataMax"] } }
    );
    expect(base).toHaveLength(1);
    expect(warn).toHaveLength(1);
    const b = points(base[0]!);
    const w = points(warn[0]!);
    const high = b[0]![1];
    const xs = [...new Set([...b, ...w].map(([x]) => x))].sort((p, q) => p - q);
    expect(b.every(([, y]) => y === high)).toBe(true);
    expect(b[b.length - 1]![0]).toBe(xs[2]);
    expect(w[0]).toEqual([xs[2], high]);
    const low = w.filter(([, y]) => y !== high);
    expect(low.length).toBeGreaterThan(0);
    expect(low.every(([x, y]) => y > high && x >= xs[2]! && x <= xs[4]!)).toBe(true);
    expect(w[w.length - 1]).toEqual([xs[4], high]);
  });
});

describe("overlay hover dot", () => {
  it("hides the warning dot on an inserted step row", () => {
    expect(overlayDotVisible({ bucket: 2, value: 0, __warningOverlay: 1 }, "value")).toBe(false);
    expect(overlayDotVisible({ bucket: 2, value: 0, __warningOverlay: 0 }, "value")).toBe(true);
    expect(overlayDotVisible({ bucket: 2, value: null, __warningOverlay: null }, "value")).toBe(
      false
    );
  });
});

describe("ChartLine reference areas", () => {
  it("fails when reference areas are not drawn", () => {
    const { html } = render([1, 2, 3, 4, 5, 6], undefined, {
      lineType: "linear",
      xAxisProps: { type: "number", domain: [0, 5] },
      referenceAreas: [
        { x1: 1, x2: 2, fill: WARN },
        { x1: 3, x2: 4, fill: WARN, label: "Degraded" },
      ],
    });
    expect(html.match(/recharts-reference-area-rect/g)).toHaveLength(2);
    expect(html).toContain(">Degraded<");
  });
});
