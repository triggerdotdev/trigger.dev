import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyse, cluster, fileIssues, issueBody, searchGaps, terms } from "./content-gaps.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/content-gaps.json", import.meta.url)));

describe("content gaps", () => {
  it("drops keystroke prefixes and clicked searches", () => {
    const gaps = searchGaps(fixture.searches, fixture.clicks);
    expect(gaps.map((g) => g.text)).not.toContain("ret");
    expect(gaps.map((g) => g.text)).not.toContain("retry");
    expect(gaps.map((g) => g.text)).not.toContain("batch trigger");
    expect(gaps).toContainEqual({ kind: "search: no results", text: "gpu" });
  });

  it("groups similar questions and keeps unrelated ones apart", () => {
    const { clusters } = analyse(fixture);
    const gpu = clusters.find((c) => c.examples.includes("gpu machines"));
    expect(gpu?.count).toBe(3);
    expect(gpu?.examples).toContain("machines gpu");
    const python = clusters.find((c) => c.examples.includes("python version"));
    expect(python?.examples).toContain("which python versions");
    expect(clusters.find((c) => c.examples.includes("how do retries work?"))).toBeUndefined();
    expect(clusters.some((c) => c.kinds["ask: thumbs down"])).toBe(true);
  });

  it("gives a cluster the same key whatever order the questions come in", () => {
    const gaps = [
      { kind: "search: no results", text: "GPU machines" },
      { kind: "search: no results", text: "gpu machine" },
      { kind: "ask: no citations", text: "deploy from gitlab" },
    ];
    const a = cluster(gaps)
      .map((c) => c.key)
      .sort();
    const b = cluster([...gaps].reverse())
      .map((c) => c.key)
      .sort();
    expect(a).toEqual(b);
    expect(issueBody(cluster(gaps)[0])).toContain(cluster(gaps)[0].key);
  });

  // Catches: a reader's pasted key or email, or markdown and mentions, landing in a Linear issue.
  it("redacts reader text and quotes it in the issue", () => {
    const { clusters } = analyse({
      searches: [],
      answers: [
        { question: "why does tr_dev_abc123 fail for jane@example.com @eric [x](https://e.vil)" },
      ],
      feedback: [],
    });
    const body = issueBody(clusters[0]);
    expect(clusters[0].title).not.toMatch(/tr_dev|jane@/);
    expect(body).not.toMatch(/tr_dev_abc123|jane@example\.com/);
    expect(body).toContain("- `why does [key] fail for [email] @eric [x](https://e.vil)`");
  });

  // Catches: singular and plural questions never grouping ("machine" vs "machines").
  it("strips stop words and plurals", () => {
    expect(terms("How do I use the GPU machines?")).toEqual(["gpu", "machine"]);
    expect(terms("gpu machine")).toEqual(["gpu", "machine"]);
    expect(terms("retries batches queues")).toEqual(terms("retry batch queue"));
    expect(terms("class")).toEqual(["class"]);
  });
});

describe("filing content gaps in Linear", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Catches: the same topic filed again the week another phrasing of it leads.
  it("files a topic once across weeks, whichever phrasing leads", async () => {
    vi.stubEnv("LINEAR_API_KEY", "test");
    vi.stubEnv("LINEAR_TEAM_ID", "team");
    vi.stubEnv("LINEAR_PROJECT_ID", "project");
    const issues = [];
    vi.stubGlobal("fetch", async (_url, init) => {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("issueCreate")) {
        issues.push(variables.input.description);
        return Response.json({
          data: { issueCreate: { issue: { identifier: `TRI-${issues.length}`, url: "" } } },
        });
      }
      const keys = variables.f.or.map((o) => o.description.contains);
      const hit = issues.findIndex((d) => keys.some((k) => d.includes(k)));
      return Response.json({
        data: { issues: { nodes: hit < 0 ? [] : [{ identifier: `TRI-${hit + 1}` }] } },
      });
    });
    const week = (lead, other) => [
      ...Array(4).fill({ kind: "search: no results", text: lead }),
      ...Array(2).fill({ kind: "search: no results", text: other }),
    ];
    expect(await fileIssues(cluster(week("gpu machines", "gpu machines python")), 3)).toEqual([
      expect.stringMatching(/filed TRI-1$/),
    ]);
    expect(await fileIssues(cluster(week("gpu machines python", "gpu machines")), 3)).toEqual([
      expect.stringMatching(/already filed as TRI-1$/),
    ]);
    expect(issues).toHaveLength(1);
  });
});
