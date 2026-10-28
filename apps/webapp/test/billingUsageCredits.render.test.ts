// @vitest-environment jsdom
import type { BillingAddOns, BillingUsageCredit } from "@trigger.dev/billing";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddOnsTab } from "~/components/billing/usage/AddOnsTab";
import { UsageCreditsRows } from "~/components/billing/usage/UsageCreditsRows";

const money = (amount: number) => `$${(amount / 100).toFixed(2)}`;

const credits: BillingUsageCredit[] = [
  {
    id: "free",
    name: "Free monthly credit",
    kind: "credit",
    source: "plan",
    amount: 193.55,
    applied: 80,
    forUsage: 193.55,
    startsAt: "2026-10-20T00:00:00Z",
    endsAt: "2026-10-20T17:00:00Z",
  },
  {
    id: "unused",
    name: "Unused time on 3 × 50 concurrent runs after 21 Oct 2026",
    kind: "credit",
    source: "proration",
    amount: 1008,
    applied: 0,
    forUsage: 0,
    startsAt: "2026-10-21T14:00:00Z",
    endsAt: "2031-10-21T14:00:00Z",
  },
];

function rows(
  list: BillingUsageCredit[],
  options: { available?: number; applied?: number; isLoading?: boolean } = {}
) {
  return createElement(
    "table",
    null,
    createElement(
      "tbody",
      null,
      createElement(UsageCreditsRows, {
        available: options.available ?? 193.55,
        applied: options.applied ?? 80,
        credits: list,
        money,
        columns: 4,
        isLoading: options.isLoading,
      })
    )
  );
}

describe("UsageCreditsRows", () => {
  it("shows one line with the credit applied to usage next to what was available, closed by default", () => {
    const html = renderToStaticMarkup(rows(credits, { available: 2372, applied: 80 }));

    expect(html).toContain("Included usage credit");
    expect(html).toContain("$23.72 available · $0.80 applied to usage");
    expect(html).toContain("−$0.80");
    expect(html).not.toContain("Free monthly credit");
  });

  it("opens into each credit's source, period, what was available and what applied", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(rows(credits)));

    await act(async () => container.querySelector("button")?.click());

    const text = container.textContent ?? "";
    expect(text).toContain("Free monthly credit");
    expect(text).toContain("Plan credit");
    expect(text).toContain("$1.94 available · $0.80 applied to usage");
    expect(text).toContain("Unused time credit");
    expect(text).toContain("Pays fees and add-ons");
    root.unmount();
  });

  it("shows a single credit's source, available and applied on the line instead of expanding", () => {
    const html = renderToStaticMarkup(rows([credits[0]]));

    expect(html).not.toContain("<button");
    expect(html).toContain("Plan credit");
    expect(html).toContain("$1.94 available · $0.80 applied to usage");
  });

  it("shows a plan's name instead of its code", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(rows([credits[0], { ...credits[1], name: "Unused v3_hobby_1 fee" }]))
    );

    await act(async () => container.querySelector("button")?.click());

    expect(container.textContent).toContain("Unused Hobby fee");
    expect(container.textContent).not.toContain("v3_hobby_1");
    root.unmount();
  });

  it("holds the amounts back while earlier days load", () => {
    const html = renderToStaticMarkup(rows(credits, { isLoading: true }));

    expect(html).toContain('aria-label="Loading"');
    expect(html).not.toContain("−$0.80");
  });
});

describe("AddOnsTab", () => {
  const addOns: BillingAddOns = {
    organizationId: "org_1",
    fetchedAt: "2026-10-27T12:00:00.000Z",
    month: "2026-10",
    creditType: null,
    invoiceDate: "2026-11-01",
    next: [
      {
        productId: "conc",
        name: "Additional Concurrency",
        quantity: 2,
        unitPrice: 1000,
        total: 2000,
      },
      { productId: "seats", name: "Additional Seats", quantity: 1, unitPrice: 2000, total: 2000 },
    ],
    charged: [{ name: "Unused v3_hobby_1 fee applied", date: "2026-10-20", total: -363 }],
  };

  function text(value: BillingAddOns) {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(createElement(AddOnsTab, { addOns: value }));
    return container.textContent ?? "";
  }

  it("shows next month's add-on quantities with a total, and this month's charges below", () => {
    const html = renderToStaticMarkup(createElement(AddOnsTab, { addOns }));

    expect(html).toContain("Nov 1, 2026");
    expect(html).toContain("Additional Concurrency");
    expect(html).toContain("$40.00");
    expect(html).toContain("Charged this month");
    expect(html).toContain("−$3.63");
  });

  it("shows how much an add-on adds, with the packs it came in", () => {
    expect(text(addOns)).toContain("100 concurrent runs (2 × 50)");
    expect(text(addOns)).toContain("1 seat");
  });

  it("shows a plan's name instead of its code in a charge", () => {
    expect(text(addOns)).toContain("Unused Hobby fee applied");
    expect(text(addOns)).not.toContain("v3_hobby_1");
  });

  it("renders nothing after the last charge", () => {
    expect(text(addOns).endsWith("−$3.63")).toBe(true);
    expect(text({ ...addOns, charged: [] }).endsWith("$40.00")).toBe(true);
  });

  it("says so when nothing is on the next invoice", () => {
    const html = renderToStaticMarkup(
      createElement(AddOnsTab, { addOns: { ...addOns, next: [], charged: [] } })
    );

    expect(html).toContain("No add-ons on the next invoice");
    expect(html).not.toContain("Charged this month");
  });
});
