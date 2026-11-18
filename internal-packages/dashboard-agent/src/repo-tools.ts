import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import type { JSONValue } from "@ai-sdk/provider";
import { sliceWellFormed } from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import { resolveTarget, type TargetInput } from "./tool-api";
import type { EnvTarget } from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";
import { fenceUntrusted } from "./tool-curation";
import {
  getRepoInfoSchema,
  listFilesSchema,
  readFileSchema,
  searchCodeSchema,
} from "./tool-schemas";

const execFileAsync = promisify(execFile);

/**
 * Code-mode tools: read the user's connected repo from the agent task's own
 * filesystem. The webapp resolves a short-lived signed tarball URL for the repo
 * at a specific commit (the GitHub token never reaches here) and injects it as
 * `repoSnapshot` in the turn metadata. The first file tool of a turn downloads +
 * extracts that tarball into a scratch workdir keyed by commit, then `ripgrep`
 * and plain fs reads serve the tools. The workspace is re-derivable: a cold
 * resume just re-fetches.
 *
 * Like the API tools, these return `{ error }` instead of throwing so the model
 * can recover and explain.
 */

export type RepoSnapshot = {
  /** Signed, time-limited archive URL (GitHub codeload). No auth needed to GET. */
  tarballUrl: string;
  owner: string;
  repo: string;
  /** The commit the archive is pinned to. */
  sha: string;
  defaultBranch?: string;
};

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024; // 100MB ceiling on the download
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;

// The snapshot fetch is a network primitive on an internal worker, so the URL must be one
// the webapp would have minted: https to GitHub's own archive hosts (the signed redirect
// target of the `tarball` API is codeload). A validation failure is thrown before any
// request leaves the worker.
const ALLOWED_TARBALL_HOSTS = new Set(["codeload.github.com"]);

function assertAllowedTarballUrl(snapshot: RepoSnapshot): void {
  let url: URL;
  try {
    url = new URL(snapshot.tarballUrl);
  } catch {
    throw new Error("repo snapshot URL is not a valid URL");
  }
  if (url.protocol !== "https:" || !ALLOWED_TARBALL_HOSTS.has(url.hostname)) {
    throw new Error(`repo snapshot URL host is not allowed (${url.hostname || "unparseable"})`);
  }
  // The archive must be the one the labels name, so a workspace keyed on them holds that repo.
  const { owner, repo, sha } = snapshot;
  if (
    !/^[0-9a-f]{40}$/i.test(sha) ||
    url.pathname.toLowerCase() !== `/${owner}/${repo}/legacy.tar.gz/${sha}`.toLowerCase()
  ) {
    throw new Error("repo snapshot URL doesn't match its owner, repo and commit");
  }
}
// A tool result the model has to pay for on every later turn of the conversation:
// 48KB is ~12k tokens, where the old 256KB ceiling was ~65k.
export const MAX_READ_BYTES = 48 * 1024;
export const MAX_READ_LINES = 1500;
const MAX_LIST_FILES = 500;
const MAX_MATCHES = 80;
const FETCH_TIMEOUT_MS = 30_000;

// Points at the mechanism the prompt already teaches — the stack-trace line is
// where a truncated read gets resumed.
const READ_TRUNCATION_NOTICE =
  `Truncated to the first ${MAX_READ_LINES} lines / ${MAX_READ_BYTES / 1024}KB. ` +
  "Read the part you need with startLine and endLine - the line from the stack trace or the search match is where to start.";

/** Caps a read at both ceilings, whichever bites first. */
function capRead(content: string): { content: string; truncated: boolean } {
  const lines = content.split("\n");
  let capped = lines.length > MAX_READ_LINES ? lines.slice(0, MAX_READ_LINES).join("\n") : content;
  if (Buffer.byteLength(capped, "utf8") > MAX_READ_BYTES) {
    capped = Buffer.from(capped, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8");
  }
  return { content: capped, truncated: capped.length !== content.length };
}

// In-flight + completed extractions, keyed by workdir, so concurrent tool calls
// in a turn extract once. Module scope: shared across turns of a warm run.
const workspaces = new Map<string, Promise<string>>();

export function workdirFor(snapshot: RepoSnapshot): string {
  // Hash the identity so different (owner, repo, sha) tuples can't collide onto
  // the same workspace dir (e.g. via hyphen placement), which would let one
  // repo reuse another's extracted source.
  const key = createHash("sha256")
    .update(`${snapshot.owner}\0${snapshot.repo}\0${snapshot.sha}`)
    .digest("hex");
  return join(tmpdir(), "dashboard-agent-repo", key);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadWithin(res: Response, path: string, maxBytes: number): Promise<void> {
  const file = await open(path, "w");
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`archive too large (over ${maxBytes} bytes)`);
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
}

export async function assertGunzipsWithin(path: string, maxBytes: number): Promise<void> {
  let total = 0;
  try {
    await pipeline(
      createReadStream(path),
      createGunzip(),
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) {
          total += chunk.length;
          if (total > maxBytes) throw new Error("over cap");
        }
      }
    );
  } catch (error) {
    // Node 20 surfaces a sink error as an AbortError.
    if (total > maxBytes) throw new Error(`archive expands past ${maxBytes} bytes`);
    throw error;
  }
}

// Download the signed tarball and extract it (strip the GitHub top-level dir).
// Memoized per workdir; a present `.ready` marker means a prior extraction
// finished, so a warm run reuses it.
async function ensureWorkspace(snapshot: RepoSnapshot): Promise<string> {
  assertAllowedTarballUrl(snapshot);
  const workdir = workdirFor(snapshot);
  const existing = workspaces.get(workdir);
  if (existing) return existing;

  const job = (async () => {
    if (await exists(join(workdir, ".ready"))) return workdir;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let scratch: string | undefined;
    try {
      // No redirects: the server resolves the one hop to a signed codeload URL itself, so
      // following one here would just reopen the host check to a redirect target.
      const res = await fetch(snapshot.tarballUrl, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) throw new Error(`archive download failed (status ${res.status})`);
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_ARCHIVE_BYTES) throw new Error(`archive too large (${length} bytes)`);

      scratch = await mkdtemp(join(tmpdir(), "dashboard-agent-tar-"));
      const tarPath = join(scratch, "repo.tar.gz");
      await downloadWithin(res, tarPath, MAX_ARCHIVE_BYTES);
      await assertGunzipsWithin(tarPath, MAX_EXTRACTED_BYTES);

      // List the archive's top-level entries before extracting: anything that resolves
      // outside the root after `--strip-components=1` (`..` segments, absolute paths)
      // rejects the archive. Both bsdtar and GNU tar refuse `..` members outright; this
      // rejects rather than relying on the extractor, and the read tools' realpath checks
      // keep any surviving symlink member from pointing a read outside the root.
      const { stdout: listing } = await execFileAsync("tar", ["-tzf", tarPath], {
        // The listing is a line per member; a 100MB archive can't hold more members
        // than this fits at any plausible path length.
        maxBuffer: 64 * 1024 * 1024,
      });
      const roots = new Set<string>();
      for (const entry of listing.split("\n")) {
        const name = entry.replace(/\/+$/, "");
        if (!name) continue;
        if (isAbsolute(name) || name.split("/").includes("..")) {
          throw new Error(`archive entry escapes the workspace (${name})`);
        }
        roots.add(name.split("/")[0]);
        if (roots.size > 1) {
          throw new Error("archive has more than one top-level entry; refusing to extract");
        }
      }

      await mkdir(workdir, { recursive: true });
      await execFileAsync("tar", ["-xzf", tarPath, "-C", workdir, "--strip-components=1"]);
      await writeFile(join(workdir, ".ready"), snapshot.sha);
      return workdir;
    } finally {
      clearTimeout(timer);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  })();

  workspaces.set(workdir, job);
  try {
    return await job;
  } catch (error) {
    // Don't cache a failed extraction; let the next call retry.
    workspaces.delete(workdir);
    throw error;
  }
}

// Resolve a tool-supplied path inside the workspace, rejecting any `..` escape.
// Lexical only — pair with a realpath check before touching the path so a
// symlink inside the repo can't point readFile/rg at something outside.
function safeResolve(workdir: string, input: string): string | null {
  const cleaned = input.replace(/^\/+/, "");
  if (isAbsolute(cleaned)) return null;
  const target = resolve(workdir, cleaned);
  if (target !== workdir && !target.startsWith(workdir + sep)) return null;
  return target;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Dispose extracted workspaces. Production run containers are ephemeral (the fs
 * is torn down at run end), so this is mainly for dev hygiene and tests.
 */
export async function disposeRepoWorkspaces(): Promise<void> {
  const dirs = [...workspaces.keys()];
  workspaces.clear();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
}

/** Resolve a run-pinned snapshot for a runId, or null. See the webapp's repo/snapshot route. */
export type RunSnapshotResolver = (
  runId: string,
  target: EnvTarget
) => Promise<RepoSnapshot | null>;

// The reader resolves the target once and hands it over, so the source ledger never has to
// resolve it again and reach a different answer.
export type SourceReadReporter = (read: {
  path: string;
  sha: string;
  target?: EnvTarget;
  /** Whether the read named a project, environment or branch of its own. */
  targeted: boolean;
}) => void | Promise<void>;

// The UI keeps the structured copy; the model gets repo text fenced.
function sourceModelOutput(output: any): JSONValue {
  const fence = (text: string) => fenceUntrusted("source", text, MAX_READ_BYTES);
  if (typeof output?.content === "string") return { ...output, content: fence(output.content) };
  if (Array.isArray(output?.files)) return { ...output, files: fence(output.files.join("\n")) };
  if (Array.isArray(output?.matches)) {
    const lines = output.matches.map((m: { file?: string; line?: number; text: string }) =>
      m.file === undefined ? m.text : `${m.file}:${m.line}:${m.text}`
    );
    return { ...output, matches: fence(lines.join("\n")) };
  }
  return output;
}

export function buildRepoTools(
  defaultSnapshot: RepoSnapshot,
  ctx: DashboardAgentToolContext,
  options: { resolveRunSnapshot?: RunSnapshotResolver; onSourceRead?: SourceReadReporter } = {}
): ToolSet {
  const { resolveRunSnapshot, onSourceRead } = options;
  // A runId pins to that run's deployed commit; otherwise the default tracked-branch
  // snapshot, which is the conversation's own repo — another environment needs a run to pin to.
  type Resolved = { snapshot: RepoSnapshot; target?: EnvTarget; targeted: boolean };
  async function snapshotFor(
    input: TargetInput & { runId?: string }
  ): Promise<Resolved | { error: string }> {
    const named =
      input.project !== undefined || input.environment !== undefined || input.branch !== undefined;
    // An untargeted read needs no environment at all — a missing one just means no scope.
    if (!input.runId && !named) {
      const scope = await resolveTarget({}, ctx, "read source from");
      return {
        snapshot: defaultSnapshot,
        targeted: false,
        ...(scope.ok ? { target: scope.target } : {}),
      };
    }
    const resolved = await resolveTarget(input, ctx, "read source from");
    if (!resolved.ok) return { error: resolved.error };
    if (!input.runId) {
      return resolved.conversationScope
        ? { snapshot: defaultSnapshot, target: resolved.target, targeted: named }
        : {
            error:
              "Name a runId too: source in another environment is read from the commit one of its runs deployed.",
          };
    }
    if (!resolveRunSnapshot)
      return { error: "Reading a specific run's source isn't available here." };
    const snap = await resolveRunSnapshot(input.runId, resolved.target);
    if (!snap) {
      return {
        error: `Couldn't resolve the source for ${input.runId} (it may be a dev run, or the project has no connected repo).`,
      };
    }
    return { snapshot: snap, target: resolved.target, targeted: named };
  }

  // snapshotFor + ensureWorkspace, returning the workdir or an error result.
  async function loadWorkdir(
    input: TargetInput & { runId?: string }
  ): Promise<(Resolved & { workdir: string }) | { error: string }> {
    const resolved = await snapshotFor(input);
    if ("error" in resolved) return resolved;
    try {
      // Canonicalize the root so the per-tool realpath checks below compare
      // against the real workspace path (tmpdir is itself a symlink on macOS).
      return { ...resolved, workdir: await realpath(await ensureWorkspace(resolved.snapshot)) };
    } catch (error) {
      return { error: `Couldn't load the repository: ${(error as Error).message}` };
    }
  }

  return {
    get_repo_info: tool({
      ...getRepoInfoSchema,
      execute: async (input) => {
        const resolved = await snapshotFor(input);
        if ("error" in resolved) return resolved;
        const { snapshot } = resolved;
        return {
          owner: snapshot.owner,
          repo: snapshot.repo,
          sha: snapshot.sha,
          defaultBranch: snapshot.defaultBranch,
        };
      },
    }),

    list_files: tool({
      ...listFilesSchema,
      execute: async (input) => {
        const { glob, path } = input;
        const loaded = await loadWorkdir(input);
        if ("error" in loaded) return loaded;
        const { workdir } = loaded;
        const args = ["--files"];
        if (glob) args.push("-g", glob);
        const sub = path ? safeResolve(workdir, path) : workdir;
        if (sub === null) return { error: "Path escapes the repository root." };
        // Resolve symlinks: reject only when the path exists and points outside.
        const realSub = await realpath(sub).catch(() => null);
        if (realSub && !isInside(workdir, realSub)) {
          return { error: "Path escapes the repository root." };
        }
        const cwd = realSub ?? sub;
        try {
          const { stdout } = await execFileAsync("rg", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
          const files = stdout
            .split("\n")
            .filter(Boolean)
            .map((f) => relative(workdir, resolve(cwd, f)));
          return {
            files: files.slice(0, MAX_LIST_FILES),
            truncated: files.length > MAX_LIST_FILES,
          };
        } catch (error) {
          // rg exits 1 when there are no matches; treat as empty, not an error.
          if ((error as { code?: number }).code === 1) return { files: [], truncated: false };
          return { error: `Couldn't list files: ${(error as Error).message}` };
        }
      },
      toModelOutput: ({ output }) => ({ type: "json", value: sourceModelOutput(output) }),
    }),

    read_file: tool({
      ...readFileSchema,
      execute: async (input) => {
        const { path, startLine, endLine } = input;
        const loaded = await loadWorkdir(input);
        if ("error" in loaded) return loaded;
        const { workdir } = loaded;
        const target = safeResolve(workdir, path);
        if (target === null) return { error: "Path escapes the repository root." };
        // Resolve symlinks: reject only when the file exists and points outside
        // (a missing file falls through to the not-found error below).
        const realTarget = await realpath(target).catch(() => null);
        if (realTarget && !isInside(workdir, realTarget)) {
          return { error: "Path escapes the repository root." };
        }
        let whole: string;
        try {
          whole = (await readFile(realTarget ?? target)).toString("utf8");
        } catch {
          return { error: `Couldn't read ${path} (not found or not a file).` };
        }
        // A targeted read is citable only with the scope it resolved, so it is never reported without one.
        if (!loaded.targeted || loaded.target) {
          await onSourceRead?.({
            path,
            sha: loaded.snapshot.sha,
            target: loaded.target,
            targeted: loaded.targeted,
          });
        }
        // The range is applied before the cap: capping first made a range past the
        // ceiling come back empty rather than as the lines that were asked for.
        if (startLine != null || endLine != null) {
          const lines = whole.split("\n");
          const from = Math.max(1, startLine ?? 1);
          const to = Math.min(lines.length, endLine ?? lines.length);
          const range = capRead(lines.slice(from - 1, to).join("\n"));
          // The cap can cut the range short, and a line number that outruns the
          // content is a citation anchored to a line the model never saw.
          const served = Math.min(to, from + range.content.split("\n").length - 1);
          return {
            path,
            content: range.content,
            startLine: from,
            endLine: served,
            ...(range.truncated ? { truncated: true, notice: READ_TRUNCATION_NOTICE } : {}),
          };
        }
        const { content, truncated } = capRead(whole);
        return {
          path,
          content,
          truncated,
          ...(truncated ? { notice: READ_TRUNCATION_NOTICE } : {}),
        };
      },
      toModelOutput: ({ output }) => ({ type: "json", value: sourceModelOutput(output) }),
    }),

    search_code: tool({
      ...searchCodeSchema,
      execute: async (input) => {
        const { query, glob, maxResults } = input;
        const loaded = await loadWorkdir(input);
        if ("error" in loaded) return loaded;
        const { workdir } = loaded;
        const cap = Math.min(maxResults ?? 40, MAX_MATCHES);
        const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", "5"];
        if (glob) args.push("-g", glob);
        // The trailing "." is required: with no path, rg reads stdin (an open pipe
        // in a spawned process) and blocks forever. The "." makes it search files.
        args.push("-e", query, ".");
        try {
          const { stdout } = await execFileAsync("rg", args, {
            cwd: workdir,
            maxBuffer: 16 * 1024 * 1024,
          });
          const matches = stdout
            .split("\n")
            .filter(Boolean)
            .slice(0, cap)
            .map((line) => {
              const m = line.match(/^([^:]+):(\d+):(.*)$/);
              return m
                ? { file: m[1], line: Number(m[2]), text: sliceWellFormed(m[3], 300) }
                : { text: line };
            });
          return { matches, truncated: matches.length >= cap };
        } catch (error) {
          if ((error as { code?: number }).code === 1) return { matches: [], truncated: false };
          return { error: `Couldn't search: ${(error as Error).message}` };
        }
      },
      toModelOutput: ({ output }) => ({ type: "json", value: sourceModelOutput(output) }),
    }),
  };
}
