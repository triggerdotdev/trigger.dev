import { chat } from "@trigger.dev/sdk/ai";
import { logger } from "@trigger.dev/sdk";
import { tool } from "ai";
import type { InferUITools, UIDataTypes, UIMessage } from "ai";
import { z } from "zod";
import { resolve } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { git, githubApi } from "@/lib/pr-review-helpers";
import { runInPRReviewSandbox } from "@/lib/pr-review-sandbox";

// #region Repo context — shared across tools, survives snapshot/restore
export const repo = chat.local<{
  cwd: string;
  owner: string;
  repo: string;
  githubToken: string | null;
  openPRs: Array<{
    number: number;
    title: string;
    author: string;
    headBranch: string;
  }>;
  activePR: { number: number; headBranch: string } | null;
}>({ id: "repo" });
// #endregion

// #region Tool: Fetch PR
export const fetchPR = tool({
  description:
    "Fetch a pull request by number. Checks out the PR branch in the local clone " +
    "and returns metadata, the diff against the base branch, and the list of changed files. " +
    "Always call this before reviewing a PR.",
  inputSchema: z.object({
    prNumber: z.number().describe("The PR number to fetch"),
  }),
  execute: async ({ prNumber }) => {
    const { cwd, owner, repo: repoName, githubToken } = repo;

    logger.info("fetchPR: fetching metadata", { owner, repo: repoName, prNumber });

    // 1. Fetch PR metadata from GitHub API
    const pr = await githubApi<{
      title: string;
      body: string | null;
      head: { ref: string; sha: string };
      base: { ref: string };
      user: { login: string };
      additions: number;
      deletions: number;
      changed_files: number;
    }>(`/repos/${owner}/${repoName}/pulls/${prNumber}`, githubToken);

    logger.info("fetchPR: got PR metadata", {
      title: pr.title,
      head: pr.head.ref,
      base: pr.base.ref,
      author: pr.user.login,
    });

    // 2. Fetch the PR branch and check it out (must happen before fetching
    //    the base branch, since base is currently checked out after clone)
    logger.info("fetchPR: fetching head branch", { branch: pr.head.ref, cwd });
    await git(cwd, "fetch", "origin", `${pr.head.ref}:${pr.head.ref}`);

    logger.info("fetchPR: checking out head branch", { branch: pr.head.ref });
    await git(cwd, "checkout", pr.head.ref);

    // 3. Now fetch the base branch (safe because we're no longer on it)
    logger.info("fetchPR: fetching base branch", { branch: pr.base.ref });
    await git(cwd, "fetch", "origin", `${pr.base.ref}:${pr.base.ref}`);

    // 4. Get the diff
    logger.info("fetchPR: computing diff", { range: `${pr.base.ref}...${pr.head.ref}` });
    const diff = await git(
      cwd,
      "diff",
      `${pr.base.ref}...${pr.head.ref}`
    );

    // 5. Get changed files list
    const filesRaw = await git(
      cwd,
      "diff",
      "--name-status",
      `${pr.base.ref}...${pr.head.ref}`
    );
    const changedFiles = filesRaw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split("\t");
        return { status: status!, path: pathParts.join("\t") };
      });

    // 6. Update active PR state
    repo.activePR = { number: prNumber, headBranch: pr.head.ref };

    logger.info("fetchPR: done", {
      changedFileCount: changedFiles.length,
      diffLength: diff.length,
      diffTruncated: diff.length > 50_000,
    });

    // 7. Truncate diff if too large
    const maxDiffLength = 50_000;
    const truncated = diff.length > maxDiffLength;

    return {
      number: prNumber,
      title: pr.title,
      body: pr.body?.slice(0, 2000) ?? "(no description)",
      author: pr.user.login,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFileCount: pr.changed_files,
      changedFiles,
      diff: truncated ? diff.slice(0, maxDiffLength) : diff,
      diffTruncated: truncated,
    };
  },
});
// #endregion

// #region Tool: Read File
export const readFile = tool({
  description:
    "Read a file from the cloned repository. Use this to see full file context " +
    "beyond what the diff shows — essential for understanding surrounding code, " +
    "imports, type definitions, and related functions.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the repo root"),
    startLine: z
      .number()
      .optional()
      .describe("Start reading from this line (1-indexed)"),
    endLine: z
      .number()
      .optional()
      .describe("Stop reading at this line (inclusive)"),
  }),
  execute: async ({ path: filePath, startLine, endLine }) => {
    const { cwd } = repo;
    const fullPath = `${cwd}/${filePath}`;

    // Security: ensure path doesn't escape the clone directory
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(resolve(cwd))) {
      return { error: "Path traversal not allowed" };
    }

    try {
      const content = await fsReadFile(resolved, "utf-8");
      const lines = content.split("\n");

      if (startLine || endLine) {
        const start = (startLine ?? 1) - 1;
        const end = endLine ?? lines.length;
        const slice = lines.slice(start, end);
        return {
          path: filePath,
          startLine: start + 1,
          endLine: Math.min(end, lines.length),
          totalLines: lines.length,
          content: slice.join("\n"),
        };
      }

      const maxLines = 500;
      return {
        path: filePath,
        totalLines: lines.length,
        content: lines.slice(0, maxLines).join("\n"),
        truncated: lines.length > maxLines,
      };
    } catch (err) {
      return {
        error: `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
// #endregion

// #region Tool: Execute Code
export const executeCode = tool({
  description:
    "Run JavaScript code in an isolated V8 sandbox to verify claims about the code. " +
    "Use this to PROVE claims (e.g., test a regex, validate parsing logic, check edge cases) " +
    "before including them in your review. The sandbox has filesystem and network access. " +
    "The repo is cloned at the provided cwd path — use it for absolute file paths. " +
    "Assign results to module.exports.",
  inputSchema: z.object({
    code: z
      .string()
      .describe(
        "JavaScript code to execute. Assign results to module.exports."
      ),
    description: z
      .string()
      .describe("Brief description of what this code is testing/verifying"),
  }),
  execute: async ({ code, description }) => {
    const { cwd } = repo;

    const result = await runInPRReviewSandbox(cwd, async (runtime) => {
      const execResult = await runtime.run<unknown>(code);

      if (execResult.code !== 0) {
        return {
          description,
          success: false as const,
          error: execResult.errorMessage ?? `Exit code ${execResult.code}`,
        };
      }

      return {
        description,
        success: true as const,
        // Sanitize the sandbox's `module.exports` so the value matches the
        // strict JSON shape that AI SDK's `jsonValueSchema` accepts. Raw JS
        // can produce `Infinity`, `NaN`, `undefined`, `BigInt`, etc., none
        // of which survive Zod v4's `z.number()` (which rejects non-finite
        // numbers). The full message history is re-validated at the start
        // of every subsequent `streamText` call, so an unsanitized value
        // here would crash the agent on the *next* turn even though the
        // current turn appears to succeed.
        result: toJsonValue(execResult.exports),
      };
    });

    // runInPRReviewSandbox returns { error } on catch
    if (result && typeof result === "object" && "error" in result && !("success" in result)) {
      return { description, success: false, error: result.error };
    }

    return result;
  },
});

/**
 * Coerce arbitrary JS to a value compatible with AI SDK's `jsonValueSchema`
 * (`null | string | number | boolean | object | array`, where `number` must
 * be finite).
 *
 * Uses `JSON.parse(JSON.stringify(...))` with a replacer so non-finite
 * numbers become `null` (matching `JSON.stringify`'s default loss for
 * `NaN`/`Infinity` when encountered as object values), `BigInt` is
 * stringified, and `undefined` / functions are dropped — same coercions
 * `JSON.stringify` already applies, but called explicitly so the result
 * is a plain JSON value tree the SDK can re-validate on later turns.
 */
function toJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "number" && !Number.isFinite(v)) return null;
        if (typeof v === "bigint") return v.toString();
        return v;
      })
    );
  } catch {
    // Circular references or other JSON.stringify failures — fall back to a
    // descriptive placeholder so the tool result is still valid JSON.
    return { error: "Result was not JSON-serializable" };
  }
}
// #endregion

// #region Exports
export const prReviewTools = { fetchPR, readFile, executeCode };

type PRReviewToolSet = typeof prReviewTools;
export type PRReviewUiTools = InferUITools<PRReviewToolSet>;
export type PRReviewUiMessage = UIMessage<unknown, UIDataTypes, PRReviewUiTools>;
// #endregion
