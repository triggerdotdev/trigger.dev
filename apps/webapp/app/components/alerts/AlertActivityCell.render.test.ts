import type * as RechartsModule from "recharts";
import { cloneElement, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AlertActivityCell } from "./AlertActivityCell";
import { ActivityTooltip, StateTooltip } from "./AlertListCells";

vi.mock("~/components/primitives/TooltipPortal", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof RechartsModule>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) =>
    cloneElement(children, { width: 112, height: 24 } as object),
}));

const HOUR = 3600_000;
const stateBuckets = (raised: (i: number) => boolean) =>
  Array.from({ length: 24 }, (_, i) => ({
    date: Date.UTC(2026, 0, 1) + i * 2 * HOUR,
    raised: raised(i),
  }));

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(AlertActivityCell, props as never));

const bars = (html: string) => html.match(/recharts-bar-rectangle"/g)?.length ?? 0;
const fullBars = (html: string) => html.match(/height="24"[^>]*class="recharts-rectangle"/g) ?? [];

describe("AlertActivityCell", () => {
  it("renders blank state without state buckets", () => {
    expect(render({})).toContain("bg-background-hover");
    expect(render({ stateBuckets: [] })).toContain("bg-background-hover");
  });

  it("draws raised buckets full height and OK buckets as ticks", () => {
    const html = render({ stateBuckets: stateBuckets((i) => i >= 20) });
    expect(bars(html)).toBe(24);
    expect(fullBars(html)).toHaveLength(4);
    expect(html).toContain("#6c5ce7");
  });

  it("labels a bucket Raised or OK in its tooltip", () => {
    const tip = (raised: boolean) =>
      renderToStaticMarkup(
        createElement(StateTooltip, {
          active: true,
          payload: [{ payload: { date: Date.UTC(2026, 0, 1, 4), raised } }],
        } as never)
      );
    expect(tip(true)).toContain(">Raised<");
    expect(tip(false)).toContain(">OK<");
    expect(tip(false)).not.toContain("Raised");
  });

  it("shows only state bars for absence rows with no buckets", () => {
    const html = render({});
    expect(html).toContain("bg-background-hover");
    expect(html).not.toContain("quiet");
  });

  it("draws an empty chart for a never-raised row", () => {
    const html = render({ stateBuckets: stateBuckets(() => false) });
    expect(bars(html)).toBe(24);
    expect(fullBars(html)).toHaveLength(0);
    expect(html).not.toContain("Never raised");
    expect(html).not.toContain("bg-background-hover");
  });

  it("words the tooltip per noun", () => {
    const render = (noun?: "run" | "occurrence") =>
      renderToStaticMarkup(
        createElement(ActivityTooltip, {
          active: true,
          payload: [{ payload: { date: new Date("2026-01-01"), count: 3 } }],
          unit: { singular: noun ?? "x", plural: `${noun ?? "x"}s` },
        } as never)
      );
    expect(render("occurrence")).toContain("occurrences");
    expect(render("run")).toContain("runs");
  });
});
