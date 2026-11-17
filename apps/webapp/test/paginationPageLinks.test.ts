import { describe, expect, it } from "vitest";
import { calculatePageLinks } from "~/components/primitives/Pagination";

const render = (currentPage: number, totalPages: number) =>
  calculatePageLinks(currentPage, totalPages)
    .map((link) => (link.type === "ellipses" ? "…" : link.page))
    .join(" ");

describe("calculatePageLinks", () => {
  // Catches: page 4 of 12 rendering "1 2 3 … 3 4 5 …", and "…" between consecutive pages.
  it.each([
    [1, 7, "1 2 3 4 5 6 7"],
    [1, 12, "1 2 3 4 … 9 10 11 12"],
    [4, 12, "1 2 3 4 5 … 10 11 12"],
    [5, 12, "1 2 3 4 5 6 … 10 11 12"],
    [6, 12, "1 2 3 4 5 6 7 … 10 11 12"],
    [8, 12, "1 2 3 … 7 8 9 10 11 12"],
    [12, 12, "1 2 3 … 8 9 10 11 12"],
    [50, 100, "1 2 3 … 49 50 51 … 98 99 100"],
  ])("page %i of %i shows %s", (currentPage, totalPages, expected) => {
    expect(render(currentPage, totalPages)).toBe(expected);
  });
});
