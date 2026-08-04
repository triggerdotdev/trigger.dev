import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "./prCommentCli.js";
import { buildReport } from "../score.js";
import { renderJson } from "./json.js";
import { scanFile } from "../scan.js";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  return { io, out: () => out.join(""), err: () => err.join("") };
};

const run = (...args: string[]) => {
  const c = capture();
  const code = main(["node", "prCommentCli.js", ...args], c.io);
  return { code, out: c.out(), err: c.err() };
};

const swallows = `import { prisma } from "~/db.server";
  export async function action() {
    try { return await prisma.token.create({ data: {} }); } catch (e) { return null; }
  }`;

const handles = `import { requireUserId } from "~/services/session.server";
  import { logger } from "~/services/logger.server";
  import { prisma } from "~/db.server";
  export async function action({ request }) {
    const userId = await requireUserId(request);
    try { return await prisma.token.create({ data: { userId } }); }
    catch (error) { logger.error("token create failed", { userId, error }); throw error; }
  }`;

describe("prCommentCli", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-map-cli-"));
  const headPath = join(dir, "head.json");
  const basePath = join(dir, "base.json");
  const unchangedPath = join(dir, "unchanged.json");

  const source = `export const loader = () => new Response("ok");`;
  const report = buildReport([scanFile("resources.a.ts", source)!], []);
  writeFileSync(headPath, renderJson(buildReport([scanFile("api.v1.t.ts", swallows)!], [])));
  writeFileSync(basePath, renderJson(buildReport([scanFile("api.v1.t.ts", handles)!], [])));
  writeFileSync(unchangedPath, renderJson(report));

  afterAll(() => rmSync(dir, { recursive: true }));

  it("renders the markdown comment for head and base file arguments", () => {
    const r = run(headPath, basePath);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("<!-- observability-map-report -->");
  });

  // B4. The job used to comment on every push, including one that moved nothing.
  it("posts nothing when the report did not move and no comment exists yet", () => {
    const r = run(unchangedPath, unchangedPath);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("replaces an existing comment with a resolved state when the delta has gone", () => {
    const r = run(unchangedPath, unchangedPath, "--existing-comment");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("<!-- observability-map-report -->");
    expect(r.out).toContain("Nothing in this pull request moves the report any more.");
    expect(r.out).not.toContain("FIX FIRST");
  });

  it("posts the full comment when there is a delta, existing comment or not", () => {
    for (const args of [
      [headPath, basePath],
      [headPath, basePath, "--existing-comment"],
    ]) {
      const r = run(...args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("FIX FIRST");
      expect(r.out).not.toContain("moves the report any more");
    }
  });

  it("prints the stale-report comment for --scan-failed without reading any file", () => {
    const r = run("--scan-failed");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("<!-- observability-map-report -->");
    expect(r.out).toContain("The scan failed for this run");
  });

  // The reconcile path. A pull request whose diff stops matching the paths the workflow watches
  // scans nothing, so there are no reports to compare and no delta to compute, and the comment an
  // earlier push left still shows findings that have gone. This is how the workflow says so.
  it("prints the resolved comment for --resolved without reading any file", () => {
    const r = run("--resolved");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("<!-- observability-map-report -->");
    expect(r.out).toContain("Nothing in this pull request moves the report any more.");
    expect(r.out).not.toContain("FIX FIRST");
  });

  describe("the commit the comment is rendered for", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const url = "https://github.com/triggerdotdev/trigger.dev/compare/1111111...2222222";
    const stamp = `As of [\`0123456\`](${url}).`;

    it("stamps the report comment from the two commit flags", () => {
      const r = run(headPath, basePath, `--commit-sha=${sha}`, `--commit-url=${url}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain(stamp);
    });

    it("stamps the resolved comment the reconcile path posts", () => {
      const r = run("--resolved", `--commit-sha=${sha}`, `--commit-url=${url}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain(stamp);
    });

    it("stamps the resolved comment the delta path posts when the delta has gone", () => {
      const r = run(
        unchangedPath,
        unchangedPath,
        "--existing-comment",
        `--commit-sha=${sha}`,
        `--commit-url=${url}`
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain(stamp);
    });

    it("stamps the stale-report comment", () => {
      const r = run("--scan-failed", `--commit-sha=${sha}`, `--commit-url=${url}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain(stamp);
    });

    // Half a pair can only come from an edit to the workflow, and a comment quietly missing the
    // line it was supposed to gain is the failure nobody would ever notice.
    it("exits 1 rather than dropping the stamp when only one of the two flags is given", () => {
      for (const half of [`--commit-sha=${sha}`, `--commit-url=${url}`]) {
        const r = run(headPath, basePath, half);
        expect(r.code).toBe(1);
        expect(r.err).toContain("have to be given together");
        expect(r.out).toBe("");
      }
    });

    // What an unset workflow expression interpolates to. Both empty is the local run.
    it("reads an empty flag value as no commit context rather than as half a pair", () => {
      const r = run(headPath, basePath, "--commit-sha=", "--commit-url=");
      expect(r.code).toBe(0);
      expect(r.out).toContain("FIX FIRST");
      expect(r.out).not.toContain("As of [");
    });
  });

  it("treats '-' as no base", () => {
    const r = run(headPath, "-");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Base comparison unavailable.");
  });

  it("treats a missing second argument as no base", () => {
    const r = run(headPath);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Base comparison unavailable.");
  });

  // Without a base there is no delta to compute, so silence would be a guess. Posting is the
  // honest answer even for a report identical to one nobody can see.
  it("posts even for an unmoved report when the base is unavailable", () => {
    const r = run(unchangedPath, "-");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Base comparison unavailable.");
  });

  it("exits 1 with a usage message when head.json is missing", () => {
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage:");
  });

  it("exits 1 with a one-line message, not a stack trace, when head.json does not exist", () => {
    const r = run(join(dir, "does-not-exist.json"));
    expect(r.code).toBe(1);
    expect(r.err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.err).toContain("cannot read head report");
    expect(r.err).not.toContain(" at ");
  });

  it("exits 1 with a one-line message, not a stack trace, when head.json is malformed", () => {
    const malformedPath = join(dir, "malformed.json");
    writeFileSync(malformedPath, "{ not json");
    const r = run(malformedPath);
    expect(r.code).toBe(1);
    expect(r.err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.err).toContain("head report is not valid JSON");
    expect(r.err).not.toContain(" at ");
  });

  describe("--out", () => {
    it("writes the comment to the file and leaves stdout empty", () => {
      const outPath = join(dir, "out-delta.md");
      const r = run(headPath, basePath, `--out=${outPath}`);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");

      const written = readFileSync(outPath, "utf8");
      expect(written.split("\n")[0]).toBe("<!-- observability-map-report -->");
    });

    it("writes an empty file when there is nothing to post, rather than no file", () => {
      const outPath = join(dir, "out-nothing.md");
      const r = run(unchangedPath, unchangedPath, `--out=${outPath}`);
      expect(r.code).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath, "utf8")).toBe("");
    });

    it("writes the resolved and scan-failed comments too", () => {
      for (const mode of ["--resolved", "--scan-failed"]) {
        const outPath = join(dir, `out${mode}.md`);
        expect(run(mode, `--out=${outPath}`).code).toBe(0);
        expect(readFileSync(outPath, "utf8").split("\n")[0]).toBe(
          "<!-- observability-map-report -->"
        );
      }
    });

    it("truncates a file left by an earlier run", () => {
      const outPath = join(dir, "out-stale.md");
      writeFileSync(outPath, "stale content from a previous push\n");
      expect(run(unchangedPath, unchangedPath, `--out=${outPath}`).code).toBe(0);
      expect(readFileSync(outPath, "utf8")).toBe("");
    });
  });

  it("exits 1 with a one-line message when base.json is malformed", () => {
    const malformedBasePath = join(dir, "malformed-base.json");
    writeFileSync(malformedBasePath, "not json at all");
    const r = run(headPath, malformedBasePath);
    expect(r.code).toBe(1);
    expect(r.err).toContain("base report is not valid JSON");
  });
});
