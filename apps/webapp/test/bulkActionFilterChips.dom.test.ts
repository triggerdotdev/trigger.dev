// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BulkActionFilterChips } from "~/components/BulkActionFilterSummary";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("BulkActionFilterChips", () => {
  // Catches: the runs list failing to render with a source filter and the bulk action panel
  // open. The filters parsed from the request carry `taskKinds` next to `sources`, and the
  // chips threw on a key they had no chip for.
  it("renders the filters parsed from a request with a source filter", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const filtersFromRequest = {
      sources: ["WEBHOOK"],
      taskKinds: ["WEBHOOK"],
    } as TaskRunListSearchFilters;

    act(() => root!.render(createElement(BulkActionFilterChips, { filters: filtersFromRequest })));

    // The time chip and one chip for the source filter.
    expect(container.firstElementChild?.children).toHaveLength(2);
  });
});
