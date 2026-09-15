import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "./cli.js";

/**
 * A routes tree of this package's own making. Run against `apps/webapp/app/routes`, these asserted the
 * webapp's contents rather than this CLI, and a route rename broke them for whoever pushed next. The
 * one deliberate real-tree test lives in `integration.test.ts`.
 */
const ROUTES = mkdtempSync(join(tmpdir(), "obs-map-fixture-routes-"));

const withWork = (name: string) => `import { prisma } from "~/db.server";
  export async function loader() {
    try { return await prisma.${name}.findMany(); } catch (e) { return null; }
  }`;

const FIXTURES: Record<string, string> = {
  // Exact target, and also the prefix of the two below it.
  "api.v1.runs.ts": withWork("run"),
  "api.v1.runs.$runId.ts": withWork("run"),
  "api.v1.runs.$runId.cancel.ts": withWork("run"),
  "api.v1.token.ts": withWork("token"),
  // Five routes sharing a prefix that is not itself a route, for the ambiguity warning and for the
  // "and N more" tail it grows past four matches.
  "admin.api.v1.runs-replication.start.ts": withWork("replication"),
  "admin.api.v1.runs-replication.stop.ts": withWork("replication"),
  "admin.api.v1.runs-replication.status.ts": withWork("replication"),
  "admin.api.v1.runs-replication.retry.ts": withWork("replication"),
  "admin.api.v1.runs-replication.purge.ts": withWork("replication"),
  // Nothing applicable: exercises the not-measured note.
  "resources.health.ts": `export const loader = () => new Response("ok");`,
  // A directive whose id names no check, for the warning it has to produce.
  "api.v1.typo.ts": `// obs-map-disable eror-classification -- typo\n${withWork("thing")}`,
};

beforeAll(() => {
  for (const [name, source] of Object.entries(FIXTURES)) {
    writeFileSync(join(ROUTES, name), source);
  }
  // A directory route, so the fixture covers both shapes `scanDirectory` walks.
  mkdirSync(join(ROUTES, "_app.orgs.$slug"));
  writeFileSync(join(ROUTES, "_app.orgs.$slug", "route.tsx"), withWork("organization"));
});

afterAll(() => rmSync(ROUTES, { recursive: true, force: true }));

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  return { io, out: () => out.join(""), err: () => err.join("") };
};

const run = (...args: string[]) => {
  const c = capture();
  const code = main(["node", "cli.js", `--routes=${ROUTES}`, ...args], c.io);
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

  it("accepts a directory route by the path its directory segment spells", () => {
    const r = run("/_app/orgs/:slug");
    expect(r.code).toBe(0);
    expect(r.out).toContain("_app.orgs.$slug/route.tsx");
  });

  it("exits 1 with a message when nothing matches", () => {
    const r = run("/api/v1/does-not-exist");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no entry point matching");
  });

  it("warns when a prefix matches more than one route rather than silently taking the first", () => {
    const r = run("/admin/api/v1/runs-replication");
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/matches 5 entry points, showing the first/);
    expect(r.err).toContain("Others:");
    expect(r.err).toContain("and 1 more");
  });

  // `/api/v1/runs` is a prefix of two others in the fixture, and also a route in its own right.
  it("prefers an exact match over the routes it is a prefix of", () => {
    const r = run("/api/v1/runs");
    expect(r.err).toBe("");
    expect(r.out.split("\n")[1]).toBe("api.v1.runs.ts");
  });

  it("says so rather than printing a bare 100 when nothing applied", () => {
    const r = run("/resources/health");
    expect(r.code).toBe(0);
    expect(r.out).toContain("not measured");
  });

  // B7. `map /api/v1/token --json` printed the text format and dropped the flag on the floor.
  it("honours --json for a single route instead of printing the text format", () => {
    const r = run("/api/v1/token", "--json");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("CHECKS");
    const parsed = JSON.parse(r.out);
    expect(parsed.fileName).toBe("api.v1.token.ts");
    expect(parsed.routePath).toBe("/api/v1/token");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe("map", () => {
  // The flag is the only thing standing between a run and a written report, so the test has to
  // check the file, not just the exit code. `--out` keeps that file in a temp directory: this test
  // used to delete `observability-map.json` from the repo root and never put it back.
  it("renders the whole report without writing when asked not to", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-map-out-"));
    const out = join(dir, "report.json");

    const r = run("--out=" + out, "--no-write");

    expect(r.code).toBe(0);
    expect(r.out).toContain("COVERAGE");
    expect(r.out).toContain("FIX FIRST");
    expect(existsSync(out)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the report where --out names it when not asked to skip the write", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-map-out-"));
    const out = join(dir, "report.json");

    const r = run("--out=" + out);

    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    expect(parsed.entries.length).toBe(Object.keys(FIXTURES).length + 1);

    rmSync(dir, { recursive: true, force: true });
  });
});

// B6. Stdout can be JSON a caller parses, so the warning goes to stderr whenever stdout is JSON.
// The terminal report carries it in its body instead (`src/report/terminal.test.ts`), and printing
// it on both streams meant a plain run showed every warning twice.
describe("warning about a suppression that names no check", () => {
  it("names the file and the bad id in the whole report", () => {
    const r = run("--no-write");
    expect(r.code).toBe(0);
    expect(r.out).toContain("api.v1.typo.ts");
    expect(r.out).toContain("eror-classification");
  });

  it("prints the warning once for a terminal run of the whole report", () => {
    const r = run("--no-write");
    const lines = `${r.out}${r.err}`.split("\n").filter((l) => l.startsWith("UNKNOWN SUPPRESSION"));
    expect(lines).toHaveLength(1);
  });

  it("names the file and the bad id on stderr when the whole report is json", () => {
    const r = run("--no-write", "--json");
    expect(r.code).toBe(0);
    expect(r.err).toContain("api.v1.typo.ts");
    expect(r.err).toContain("eror-classification");
    expect(r.out).not.toContain("UNKNOWN SUPPRESSION");
  });

  it("warns for a single route without putting the warning in the json", () => {
    const r = run("/api/v1/typo", "--json");
    expect(r.code).toBe(0);
    expect(r.err).toContain("eror-classification");
    expect(JSON.parse(r.out).fileName).toBe("api.v1.typo.ts");
  });

  it("says nothing on stderr for a route whose directives all name a check", () => {
    const r = run("/api/v1/token");
    expect(r.err).toBe("");
  });
});

describe("map --routes=<dir>", () => {
  it("scans the directory it names instead of the repo's routes tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-map-routes-"));
    writeFileSync(
      join(dir, "resources.only.ts"),
      `export const loader = () => new Response("ok");`
    );

    const c = capture();
    const code = main(["node", "cli.js", "--routes=" + dir, "--json", "--no-write"], c.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(c.out());
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].fileName).toBe("resources.only.ts");

    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 with a message when the directory does not exist", () => {
    const dir = join(tmpdir(), "obs-map-routes-does-not-exist");
    const c = capture();
    const code = main(["node", "cli.js", "--routes=" + dir], c.io);

    expect(code).toBe(1);
    expect(c.err()).toContain("not a readable directory");
    expect(c.out()).toBe("");
  });
});
