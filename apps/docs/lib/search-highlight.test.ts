import { describe, expect, test } from "vitest";
import { highlightRanges, queryTerms } from "./search-core";

const marked = (text: string, query: string) =>
  highlightRanges(text, query).map(([a, b]) => text.slice(a, b));

describe("search result highlighting", () => {
  test("whole words of the query's real terms only", () => {
    const text =
      "This example demonstrates how to use Trigger.dev to customize the build image in the case of deploying.";
    expect(marked(text, "how do I customize the image")).toEqual(["customize", "image"]);
  });

  test("stemmed forms match", () => {
    expect(marked("Customizing images and retries", "customize the image retry")).toEqual([
      "Customizing",
      "images",
      "retries",
    ]);
  });

  test("stopwords, single letters and letters inside words never highlight", () => {
    expect(marked("This is it, a big list", "i a is the")).toEqual([]);
    expect(marked("Build extensions", "i")).toEqual([]);
  });

  test("camelCase identifiers match on their parts", () => {
    expect(marked("Pass an idempotencyKey to trigger()", "idempotency key")).toEqual([
      "idempotencyKey",
    ]);
  });
});

// Catches: a long query of distinct terms making each uncached search request scan every page per term.
test("bounds a query to its first 12 distinct terms", () => {
  const terms = queryTerms(Array.from({ length: 1200 }, (_, i) => `x${i}`).join(" "));
  expect(terms.length).toBe(12);
  expect(queryTerms("retry retry retry").length).toBe(1);
});
