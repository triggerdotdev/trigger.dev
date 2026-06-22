import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRepoTools, disposeRepoWorkspaces, workdirFor, type RepoSnapshot } from "./repo-tools";

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
const resolveRunSnapshot = async (runId: string) =>
  runId === "run_pinned" ? pinnedSnapshot : null;

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
  await writeFile(join(dir, ".ready"), snapshot.sha);

  // The pinned commit's workspace, with a different LIMIT.
  const pinnedDir = workdirFor(pinnedSnapshot);
  await mkdir(join(pinnedDir, "src/trigger"), { recursive: true });
  await writeFile(join(pinnedDir, "src/trigger/order.ts"), "const LIMIT = 5000;\n");
  await writeFile(join(pinnedDir, ".ready"), pinnedSnapshot.sha);
});

afterAll(async () => {
  await disposeRepoWorkspaces();
  await rm(workdirFor(snapshot), { recursive: true, force: true });
  await rm(workdirFor(pinnedSnapshot), { recursive: true, force: true });
});

describe("repo-tools", () => {
  it("get_repo_info returns the connected repo and pinned commit", async () => {
    const res = await call(tools.get_repo_info, {});
    expect(res).toEqual({ owner: "acme", repo: "demo", sha: "deadbeefdeadbeef", defaultBranch: "main" });
  });

  it("read_file reads a file from the workspace", async () => {
    const res: any = await call(tools.read_file, { path: "src/trigger/order.ts" });
    expect(res.error).toBeUndefined();
    expect(res.path).toBe("src/trigger/order.ts");
    expect(res.content).toContain("const LIMIT = 10000;");
  });

  it("read_file honors a line range", async () => {
    const res: any = await call(tools.read_file, { path: "src/trigger/order.ts", startLine: 2, endLine: 2 });
    expect(res.content).toBe("const LIMIT = 10000;");
    expect(res.startLine).toBe(2);
    expect(res.endLine).toBe(2);
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
    const pinned: any = await call(tools.read_file, { path: "src/trigger/order.ts", runId: "run_pinned" });
    expect(pinned.error).toBeUndefined();
    expect(pinned.content).toContain("const LIMIT = 5000;");
  });

  it("get_repo_info with runId reports the pinned commit", async () => {
    const res: any = await call(tools.get_repo_info, { runId: "run_pinned" });
    expect(res.sha).toBe(pinnedSnapshot.sha);
  });

  it("read_file with an unresolvable runId errors instead of falling back", async () => {
    const res: any = await call(tools.read_file, { path: "src/trigger/order.ts", runId: "run_unknown" });
    expect(res.error).toMatch(/Couldn't resolve the source/);
  });

  it.runIf(hasRg)("search_code finds a match (and does not hang on stdin)", async () => {
    const res: any = await call(tools.search_code, { query: "const LIMIT" });
    expect(res.error).toBeUndefined();
    expect(res.matches.some((m: any) => String(m.file).includes("order.ts") && /LIMIT/.test(m.text))).toBe(true);
  });

  it.runIf(hasRg)("list_files lists workspace files", async () => {
    const res: any = await call(tools.list_files, {});
    expect(res.error).toBeUndefined();
    expect(res.files).toContain("src/trigger/order.ts");
  });
});
