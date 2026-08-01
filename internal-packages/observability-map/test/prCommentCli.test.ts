import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../src/report/prCommentCli.js";
import { buildReport } from "../src/score.js";
import { renderJson } from "../src/report/json.js";
import { scanFile } from "../src/scan.js";

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

describe("prCommentCli", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-map-cli-"));
  const headPath = join(dir, "head.json");
  const basePath = join(dir, "base.json");

  const source = `export const loader = () => new Response("ok");`;
  const report = buildReport([scanFile("resources.a.ts", source)!], []);
  writeFileSync(headPath, renderJson(report));
  writeFileSync(basePath, renderJson(report));

  afterAll(() => rmSync(dir, { recursive: true }));

  it("renders the markdown comment for head and base file arguments", () => {
    const r = run(headPath, basePath);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("<!-- observability-map-report -->");
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

  it("exits 1 with a one-line message when base.json is malformed", () => {
    const malformedBasePath = join(dir, "malformed-base.json");
    writeFileSync(malformedBasePath, "not json at all");
    const r = run(headPath, malformedBasePath);
    expect(r.code).toBe(1);
    expect(r.err).toContain("base report is not valid JSON");
  });
});
