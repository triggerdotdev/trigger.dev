import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { editDistance, FIELDS, Searcher, termFrequencies, type SearchIndex } from "./search-core";

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

describe("editDistance", () => {
  it("counts a swap of neighbours as one edit and stops past max", () => {
    expect(editDistance("machien", "machine", 2)).toBe(1);
    expect(editDistance("idempotancy", "idempotency", 2)).toBe(1);
    expect(editDistance("abc", "xyz", 1)).toBe(2);
  });
});

// Real queries readers typed that found nothing or the wrong page, against the real index.
describe("search over the docs", () => {
  let searcher: Searcher;
  beforeAll(async () => {
    execFileSync(process.execPath, ["scripts/build-search-index.mjs"], {
      cwd: `${import.meta.dirname}/..`,
      stdio: "ignore",
    });
    searcher = new Searcher((await import("../.generated/search-index.js")).default);
  }, 60_000);
  const top = (query: string, n: number) =>
    searcher.search(query, { limit: n }).map((h) => h.page.url);

  it.each([
    ["idempotancy", "/idempotency"],
    ["machien", "/machines"],
    ["quickstart", "/quick-start"],
    ["retry only on certain errors", "/errors-retrying"],
  ])("%s finds %s first", (query, url) => {
    expect(top(query, 1)).toEqual([url]);
  });

  // Catches: the index dropping every underscore with the markdown emphasis (TRIGGERSECRETKEY).
  it("keeps underscores inside words in section text", () => {
    const [hit] = searcher.search("TRIGGER_SECRET_KEY", { limit: 1 });
    expect(hit.sections.some((s) => s.text.includes("TRIGGER_SECRET_KEY"))).toBe(true);
  });

  // Catches: a term with no close match being swapped for an unrelated one (FastAPI found task docs).
  it("keeps a term with no close indexed match", () => {
    expect(top("zzzzzzzqx", 3)).toEqual([]);
  });

  it("upgrade to v4 finds the v3 migration guide near the top", () => {
    expect(top("upgrade to v4", 3)).toContain("/migrating-from-v3");
  });
});
