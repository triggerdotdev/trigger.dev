import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRepoTools,
  disposeRepoWorkspaces,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  workdirFor,
  type RepoSnapshot,
} from "./repo-tools";

// The code tools normally download + extract a tarball. Here we pre-seed the
// deterministic workspace path with a `.ready` marker, so `ensureWorkspace`
// serves it without any network fetch and the tools run fully offline.
const snapshot: RepoSnapshot = {
  tarballUrl: "http://unused.invalid/never-fetched",
  owner: "acme",
  repo: "demo",
  sha: "deadbeefdeadbeef",
  defaultBranch: "main",
};

// A second snapshot at a different commit, returned by the run-SHA resolver for
// a known run id. Its order.ts has a different LIMIT so we can tell them apart.
const pinnedSnapshot: RepoSnapshot = {
  tarballUrl: "http://unused.invalid/never-fetched",
  owner: "acme",
  repo: "demo",
  sha: "cafebabecafebabecafebabecafebabecafebabe",
  defaultBranch: "main",
};
// A third snapshot, deployed from a tree with uncommitted changes.
const dirtySnapshot: RepoSnapshot = {
  tarballUrl: "http://unused.invalid/never-fetched",
  owner: "acme",
  repo: "demo",
  sha: "dededededededededededededededededededede",
  defaultBranch: "main",
  dirty: true,
};
const resolveRunSnapshot = async (runId: string) =>
  runId === "run_pinned" ? pinnedSnapshot : runId === "run_dirty" ? dirtySnapshot : null;

const tools = buildRepoTools(snapshot, resolveRunSnapshot);
// Tool.execute takes (input, options); options is unused by these tools.
const call = (tool: any, input: any) => tool.execute(input, {} as any);

// rg may not be installed in CI; detect at collection time so the search/list
// tests skip cleanly there (they're covered end-to-end against a real repo).
let hasRg = false;
try {
  execFileSync("rg", ["--version"], { stdio: "ignore" });
  hasRg = true;
} catch {
  hasRg = false;
}

beforeAll(async () => {
  const dir = workdirFor(snapshot);
  await mkdir(join(dir, "src/trigger"), { recursive: true });
  await writeFile(
    join(dir, "src/trigger/order.ts"),
    'import { task } from "@trigger.dev/sdk";\nconst LIMIT = 10000;\nexport const order = task({ id: "order" });\n'
  );
  await writeFile(join(dir, "README.md"), "# demo\n");
  // Both ceilings blown: 4000 lines and ~200KB. Line 3000 is findable so a range
  // read can be checked past the line cap.
  await writeFile(
    join(dir, "src/trigger/huge.ts"),
    Array.from({ length: 4000 }, (_, i) => `// line ${i + 1} ${"x".repeat(40)}`).join("\n")
  );
  // 4000 short lines: under the byte ceiling, so the line ceiling is what bites.
  await writeFile(
    join(dir, "src/trigger/narrow.ts"),
    Array.from({ length: 4000 }, () => "//").join("\n")
  );
  await writeFile(join(dir, ".ready"), snapshot.sha);

  // The pinned commit's workspace, with a different LIMIT.
  const pinnedDir = workdirFor(pinnedSnapshot);
  await mkdir(join(pinnedDir, "src/trigger"), { recursive: true });
  await writeFile(join(pinnedDir, "src/trigger/order.ts"), "const LIMIT = 5000;\n");
  await writeFile(join(pinnedDir, ".ready"), pinnedSnapshot.sha);

  // The dirty commit's workspace: source built from a tree with uncommitted changes.
  const dirtyDir = workdirFor(dirtySnapshot);
  await mkdir(join(dirtyDir, "src/trigger"), { recursive: true });
  await writeFile(join(dirtyDir, "src/trigger/order.ts"), "const LIMIT = 9999;\n");
  await writeFile(join(dirtyDir, ".ready"), dirtySnapshot.sha);
});

afterAll(async () => {
  await disposeRepoWorkspaces();
  await rm(workdirFor(snapshot), { recursive: true, force: true });
  await rm(workdirFor(pinnedSnapshot), { recursive: true, force: true });
  await rm(workdirFor(dirtySnapshot), { recursive: true, force: true });
});

describe("repo-tools", () => {
  it("get_repo_info returns the connected repo and pinned commit", async () => {
    const res = await call(tools.get_repo_info, {});
    expect(res).toEqual({
      owner: "acme",
      repo: "demo",
      sha: "deadbeefdeadbeef",
      defaultBranch: "main",
      dirty: false,
    });
  });

  it("get_repo_info stamps dirty:true when the pinned deployment was built from a modified tree", async () => {
    const res: any = await call(tools.get_repo_info, { runId: "run_dirty" });
    expect(res.sha).toBe(dirtySnapshot.sha);
    expect(res.dirty).toBe(true);
  });

  it("read_file stamps dirty:true when the pinned deployment was built from a modified tree", async () => {
    const clean: any = await call(tools.read_file, { path: "src/trigger/order.ts" });
    expect(clean.dirty).toBe(false);
    const dirty: any = await call(tools.read_file, {
      path: "src/trigger/order.ts",
      runId: "run_dirty",
    });
    expect(dirty.error).toBeUndefined();
    expect(dirty.dirty).toBe(true);
  });

  it("read_file reads a file from the workspace", async () => {
    const res: any = await call(tools.read_file, { path: "src/trigger/order.ts" });
    expect(res.error).toBeUndefined();
    expect(res.path).toBe("src/trigger/order.ts");
    expect(res.content).toContain("const LIMIT = 10000;");
  });

  it("read_file honors a line range", async () => {
    const res: any = await call(tools.read_file, {
      path: "src/trigger/order.ts",
      startLine: 2,
      endLine: 2,
    });
    expect(res.content).toBe("const LIMIT = 10000;");
    expect(res.startLine).toBe(2);
    expect(res.endLine).toBe(2);
  });

  it("read_file caps a big file and tells the model how to get the rest", async () => {
    const res: any = await call(tools.read_file, { path: "src/trigger/huge.ts" });
    expect(res.truncated).toBe(true);
    expect(res.notice).toMatch(/startLine and endLine/);
    // Long lines, so the byte ceiling bites before the line ceiling.
    expect(res.content.split("\n").length).toBeLessThanOrEqual(MAX_READ_LINES);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(res.content).not.toContain("// line 1501 ");
  });

  it("read_file caps a long file of short lines at the line ceiling", async () => {
    const res: any = await call(tools.read_file, { path: "src/trigger/narrow.ts" });
    expect(res.truncated).toBe(true);
    expect(res.content.split("\n")).toHaveLength(MAX_READ_LINES);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThan(MAX_READ_BYTES);
  });

  it("read_file serves a range past the line cap, since the cap is applied after it", async () => {
    const res: any = await call(tools.read_file, {
      path: "src/trigger/huge.ts",
      startLine: 3000,
      endLine: 3002,
    });
    expect(res.truncated).toBeUndefined();
    expect(res.content.split("\n")[0]).toContain("// line 3000 ");
    expect(res.startLine).toBe(3000);
  });

  it("read_file reports the last line it actually served when the cap cuts a range short", async () => {
    const res: any = await call(tools.read_file, {
      path: "src/trigger/narrow.ts",
      startLine: 1,
      endLine: 4000,
    });
    expect(res.truncated).toBe(true);
    const served = res.content.split("\n");
    expect(served).toHaveLength(MAX_READ_LINES);
    expect(res.startLine).toBe(1);
    expect(res.endLine).toBe(MAX_READ_LINES);
  });

  it("read_file leaves a small file untruncated", async () => {
    const res: any = await call(tools.read_file, { path: "src/trigger/order.ts" });
    expect(res.truncated).toBe(false);
    expect(res.notice).toBeUndefined();
  });

  it("read_file refuses to escape the repository root", async () => {
    for (const path of ["../../../etc/passwd", "src/../../escape", "../outside.txt"]) {
      const res: any = await call(tools.read_file, { path });
      expect(res.error).toMatch(/escapes the repository root/);
    }
  });

  it("read_file errors on a missing file", async () => {
    const res: any = await call(tools.read_file, { path: "does/not/exist.ts" });
    expect(res.error).toBeDefined();
  });

  it("read_file with runId reads the run's pinned commit", async () => {
    const def: any = await call(tools.read_file, { path: "src/trigger/order.ts" });
    expect(def.content).toContain("const LIMIT = 10000;");
    const pinned: any = await call(tools.read_file, {
      path: "src/trigger/order.ts",
      runId: "run_pinned",
    });
    expect(pinned.error).toBeUndefined();
    expect(pinned.content).toContain("const LIMIT = 5000;");
  });

  it("get_repo_info with runId reports the pinned commit", async () => {
    const res: any = await call(tools.get_repo_info, { runId: "run_pinned" });
    expect(res.sha).toBe(pinnedSnapshot.sha);
  });

  it("read_file with an unresolvable runId errors instead of falling back", async () => {
    const res: any = await call(tools.read_file, {
      path: "src/trigger/order.ts",
      runId: "run_unknown",
    });
    expect(res.error).toMatch(/Couldn't resolve the source/);
  });

  // The snapshot fetch runs on an internal worker, so only GitHub's archive host is
  // allowed; anything else must fail before a request leaves the worker.
  it("refuses to fetch a snapshot whose tarballUrl is not an allowed host", async () => {
    for (const tarballUrl of [
      "http://codeload.github.com/acme/attacker/tar.gz/abc",
      "https://attacker.example.com/x.tar.gz",
      "https://github.com.evil.example/x.tar.gz",
      "not a url",
    ]) {
      const bad: RepoSnapshot = {
        tarballUrl,
        owner: "acme",
        repo: "attacker",
        sha: "b".repeat(40),
      };
      const res: any = await call(buildRepoTools(bad).read_file, { path: "README.md" });
      expect(res.error).toMatch(/Couldn't load the repository/);
      expect(res.error).toMatch(/not a valid URL|not allowed/);
    }
  });

  it.runIf(hasRg)("search_code finds a match (and does not hang on stdin)", async () => {
    const res: any = await call(tools.search_code, { query: "const LIMIT" });
    expect(res.error).toBeUndefined();
    expect(
      res.matches.some((m: any) => String(m.file).includes("order.ts") && /LIMIT/.test(m.text))
    ).toBe(true);
  });

  it.runIf(hasRg)("list_files lists workspace files", async () => {
    const res: any = await call(tools.list_files, {});
    expect(res.error).toBeUndefined();
    expect(res.files).toContain("src/trigger/order.ts");
  });
});

describe("repo tools: branch without environment", () => {
  const CASES: Array<[string, any]> = [
    ["get_repo_info", tools.get_repo_info],
    ["list_files", tools.list_files],
    ["read_file", tools.read_file],
    ["search_code", tools.search_code],
  ];

  it.each(CASES)("%s is refused before any snapshot fetch", async (_name, tool) => {
    const res: any = await call(tool, { path: "README.md", branch: "feat/x" });
    expect(res.error).toBe("branch needs environment: preview or dev.");
  });
});
