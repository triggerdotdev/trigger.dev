import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main, type Io } from "../src/cli.js";

const REPORT_FILE = resolve(__dirname, "../../../observability-map.json");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  return { io, out: () => out.join(""), err: () => err.join("") };
};

const run = (...args: string[]) => {
  const c = capture();
  const code = main(["node", "cli.js", ...args], c.io);
  return { code, out: c.out(), err: c.err() };
};

describe("map <target>", () => {
  // I8. The report prints route paths, so the identifier on screen has to be one you can paste
  // back in. Matching file names only meant `map /api/v1/token` exited 1.
  it("accepts the route path the report prints", () => {
    const r = run("/api/v1/token");
    expect(r.code).toBe(0);
    expect(r.out).toContain("/api/v1/token");
    expect(r.out).toContain("CHECKS");
  });

  it("accepts a file name too", () => {
    const r = run("api.v1.token.ts");
    expect(r.code).toBe(0);
    expect(r.out).toContain("api.v1.token.ts");
  });

  it("exits 1 with a message when nothing matches", () => {
    const r = run("/api/v1/does-not-exist");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no entry point matching");
  });

  it("warns when a prefix matches more than one route rather than silently taking the first", () => {
    const r = run("/admin/api/v1/runs-replication");
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/matches \d+ entry points, showing the first/);
    expect(r.err).toContain("Others:");
  });

  // `/api/v1/runs` is a prefix of a dozen others, and also a route in its own right.
  it("prefers an exact match over the routes it is a prefix of", () => {
    const r = run("/api/v1/runs");
    expect(r.err).toBe("");
    expect(r.out.split("\n")[1]).toBe("api.v1.runs.ts");
  });
});

describe("map", () => {
  // The flag is the only thing standing between a test run and a file written into the repo root,
  // so the test has to check the file, not just the exit code.
  it("renders the whole report without writing when asked not to", () => {
    const existedBefore = existsSync(REPORT_FILE);
    if (existedBefore) rmSync(REPORT_FILE);

    const r = run("--no-write");

    expect(r.code).toBe(0);
    expect(r.out).toContain("COVERAGE");
    expect(r.out).toContain("FIX FIRST");
    expect(existsSync(REPORT_FILE)).toBe(false);
  });
});

describe("map --routes=<dir>", () => {
  it("scans the directory it names instead of the repo's routes tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-map-routes-"));
    writeFileSync(
      join(dir, "resources.only.ts"),
      `export const loader = () => new Response("ok");`
    );

    const r = run("--routes=" + dir, "--json", "--no-write");

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].fileName).toBe("resources.only.ts");

    rmSync(dir, { recursive: true });
  });

  it("exits 1 with a message when the directory does not exist", () => {
    const dir = join(tmpdir(), "obs-map-routes-does-not-exist");
    const r = run("--routes=" + dir);

    expect(r.code).toBe(1);
    expect(r.err).toContain("not a readable directory");
    expect(r.out).toBe("");
  });
});
