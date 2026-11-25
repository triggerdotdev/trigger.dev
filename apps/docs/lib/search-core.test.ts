import { describe, expect, it } from "vitest";
import { FIELDS, Searcher, termFrequencies, type SearchIndex } from "./search-core";

describe("Searcher", () => {
  function page(url: string, text: Partial<Record<(typeof FIELDS)[number], string>>) {
    const tf = {} as SearchIndex["pages"][number]["tf"];
    const len = {} as SearchIndex["pages"][number]["len"];
    for (const f of FIELDS) [tf[f], len[f]] = termFrequencies(text[f] ?? "");
    return { url, title: text.title ?? url, inNav: true, tf, len, sections: [] };
  }

  // Catches: words that are Object.prototype keys ("constructor") scoring NaN, so search drops the page.
  it("finds words that are also Object.prototype keys, after a JSON round trip", () => {
    const pages = [
      page("/machines", { title: "Machines", code: "class ResourceMonitor { constructor() {} }" }),
      page("/tasks", { title: "Tasks", body: "Tasks run your code" }),
    ];
    const avgLen = Object.fromEntries(FIELDS.map((f) => [f, 5])) as SearchIndex["avgLen"];
    const index = JSON.parse(JSON.stringify({ pages, avgLen })) as SearchIndex;
    const hits = new Searcher(index).search("constructor");
    expect(hits.map((h) => h.page.url)).toEqual(["/machines"]);
    expect(hits[0].score).toBeGreaterThan(0);
  });
});
