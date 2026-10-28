import { describe, expect, it } from "vitest";
import { safeChartColor, safeChartConfig } from "./chartColors";

describe("safeChartColor", () => {
  it.each([
    "#abc",
    "#ABCD",
    "#123456",
    "#12345678",
    "var(--color-agents)",
    "var(--color-tasks)",
    "var(--color-queues-chart-ref)",
    "var(--color-run-completed-successfully)",
  ])("preserves supported color %s", (color) => {
    expect(safeChartColor(color)).toBe(color);
  });

  it.each([
    "</style><script>alert(1)</script>",
    '#fff" onload="alert(1)',
    "#fff; } body { background: red; } /*",
    "[data-chart], body",
    "url(https://example.com/pixel)",
    "url(javascript:alert(1))",
    "var(--color-unknown)",
    "var(--color-tasks, url(https://example.com))",
    "var(--color-tasks); background: url(https://example.com)",
    "#12345",
    "#123456789",
    "#ggg",
    "#fff\n",
    " #fff",
    undefined,
    null,
    123,
  ])("rejects unsupported color %s", (color) => {
    expect(safeChartColor(color)).toBeUndefined();
  });

  it("preserves the agent Spend chart color", () => {
    const config = { cost: { label: "Spend", color: "var(--color-agents)" } };
    expect(safeChartConfig(config)).toEqual(config);
  });

  it("validates both themes and leaves labels intact without mutating the input", () => {
    const label = "</style><script>alert(1)</script>";
    const config = {
      [label]: { label, theme: { light: "#123456", dark: "url(https://example.com)" } },
      plain: { label: "Plain", color: "#fff; color: red" },
    };
    expect(safeChartConfig(config)).toEqual({
      [label]: {
        label,
        color: undefined,
        theme: { light: "#123456", dark: "var(--color-text-dimmed)" },
      },
      plain: { label: "Plain", color: "var(--color-text-dimmed)" },
    });
    expect(config[label].theme.dark).toBe("url(https://example.com)");
  });
});
