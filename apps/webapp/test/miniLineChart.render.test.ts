import type * as RechartsModule from "recharts";
import { cloneElement, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MiniLineChart } from "~/components/metrics/MiniLineChart";

vi.mock("~/components/primitives/TooltipPortal", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const tooltip = vi.hoisted(() => ({ count: 1 }));

vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof RechartsModule>()),
  Tooltip: ({ content }: { content: ReactElement }) =>
    cloneElement(content, {
      active: true,
      payload: [{ payload: { date: new Date(0), count: tooltip.count, throttledCount: 0 } }],
    } as object),
}));

describe("MiniLineChart", () => {
  it("draws a monotone curve by default", () => {
    const html = renderToStaticMarkup(
      createElement(MiniLineChart, { data: [1, 4, 2, 5], bucketStartMs: 0 })
    );
    const path = html.match(/class="recharts-curve recharts-line-curve"[^>]* d="([^"]+)"/)?.[1];
    expect(path).toContain("C");
  });

  it("keeps count wording without a formatter", () => {
    const html = renderToStaticMarkup(
      createElement(MiniLineChart, { data: [1, 4], bucketStartMs: 0 })
    );
    expect(html).toContain(">value<");
  });
});
