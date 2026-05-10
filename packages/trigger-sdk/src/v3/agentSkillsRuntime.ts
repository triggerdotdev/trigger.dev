import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

/**
 * Server-only runtime for the auto-injected skill tools
 * (`loadSkill` / `readFile` / `bash`) that `chat.agent({ skills })`
 * wires up. Split off from `./ai.ts` so the chat-agent surface in
 * `@trigger.dev/sdk/ai` stays importable from client bundles —
 * Next.js + Webpack reject top-level `node:*` imports anywhere in a
 * client graph, even when a consumer only pulls in types.
 *
 * The SDK's `ai.ts` loads this module via a computed-string dynamic
 * import inside each tool's `execute` — webpack treats the
 * expression as an unknown dependency and skips static tracing, so
 * the node-only symbols here never surface in a client build. The
 * module resolves fine at runtime on a server worker because the
 * relative path (`./agentSkillsRuntime.js`) lands next to `ai.js` in
 * the emitted dist.
 *
 * Public subpath: `@trigger.dev/sdk/ai/skills-runtime`. Customers
 * who want to eagerly bundle the runtime server-side (e.g. warming
 * it on worker bootstrap) can import from there.
 */

const DEFAULT_BASH_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_READ_FILE_BYTES = 1024 * 1024;

export type BashSkillInput = {
  /** Absolute path to the skill's root (used as `cwd`). */
  skillPath: string;
  /** The bash command to run. */
  command: string;
  /** Optional abort signal forwarded to `spawn()`. */
  abortSignal?: AbortSignal;
};

export type BashSkillResult =
  | { exitCode: number | null; stdout: string; stderr: string }
  | { error: string };

export type ReadFileInSkillInput = {
  /** Absolute path to the skill's root — the relative path must resolve inside it. */
  skillPath: string;
  /** Relative path the tool caller supplied. */
  relativePath: string;
};

export type ReadFileInSkillResult = { content: string } | { error: string };

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…[truncated ${s.length - limit} bytes]`;
}

/**
 * Path-traversal guard: confirm `relative` resolves inside `root`.
 * Throws if it escapes via `..` or an absolute prefix. Returns the
 * absolute resolved path.
 */
function safeJoinInside(root: string, relative: string): string {
  if (nodePath.isAbsolute(relative)) {
    throw new Error(`Path must be relative to the skill directory: ${relative}`);
  }
  const resolved = nodePath.resolve(root, relative);
  const normalized = nodePath.resolve(root) + nodePath.sep;
  if (resolved !== nodePath.resolve(root) && !resolved.startsWith(normalized)) {
    throw new Error(`Path escapes the skill directory: ${relative}`);
  }
  return resolved;
}

export async function readFileInSkill({
  skillPath,
  relativePath,
}: ReadFileInSkillInput): Promise<ReadFileInSkillResult> {
  let absolute: string;
  try {
    absolute = safeJoinInside(skillPath, relativePath);
  } catch (err) {
    return { error: (err as Error).message };
  }
  try {
    const content = await fs.readFile(absolute, "utf8");
    return { content: truncate(content, DEFAULT_READ_FILE_BYTES) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function runBashInSkill({
  skillPath,
  command,
  abortSignal,
}: BashSkillInput): Promise<BashSkillResult> {
  return new Promise<BashSkillResult>((resolvePromise) => {
    let child;
    try {
      child = spawn("bash", ["-c", command], {
        cwd: skillPath,
        signal: abortSignal,
      });
    } catch (err) {
      resolvePromise({ error: (err as Error).message });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("close", (code: number | null) => {
      resolvePromise({
        exitCode: code,
        stdout: truncate(stdout, DEFAULT_BASH_OUTPUT_BYTES),
        stderr: truncate(stderr, DEFAULT_BASH_OUTPUT_BYTES),
      });
    });
    child.once("error", (err: Error) => {
      resolvePromise({ error: err.message });
    });
  });
}
