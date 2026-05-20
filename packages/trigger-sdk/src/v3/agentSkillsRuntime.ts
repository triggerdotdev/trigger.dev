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
 * Path-traversal guard: confirm `relative` resolves inside `root`,
 * even after symlinks are followed. Throws if it escapes via `..`, an
 * absolute prefix, or a symlink that points outside. Returns the
 * resolved real path.
 *
 * `fs.realpath` only works on paths that exist, so when the resolved
 * path doesn't exist yet (e.g. writing a new file) we fall back to
 * the lexical check — a non-existent path can't traverse a symlink
 * to escape since the symlink doesn't exist either.
 */
async function safeJoinInside(root: string, relative: string): Promise<string> {
  if (nodePath.isAbsolute(relative)) {
    throw new Error(`Path must be relative to the skill directory: ${relative}`);
  }
  const realRoot = await fs.realpath(nodePath.resolve(root));
  const resolved = nodePath.resolve(realRoot, relative);
  let real = resolved;
  try {
    real = await fs.realpath(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // Path doesn't exist yet; fall through with the lexical resolve.
  }
  const normalized = realRoot + nodePath.sep;
  if (real !== realRoot && !real.startsWith(normalized)) {
    throw new Error(`Path escapes the skill directory: ${relative}`);
  }
  return real;
}

export async function readFileInSkill({
  skillPath,
  relativePath,
}: ReadFileInSkillInput): Promise<ReadFileInSkillResult> {
  let absolute: string;
  try {
    absolute = await safeJoinInside(skillPath, relativePath);
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

    // Cap stdout/stderr accumulation at the byte budget so an
    // LLM-generated command (`cat /dev/zero`, `yes`) can't OOM the
    // worker. Track total seen length separately so the truncation
    // notice still reports how much was dropped.
    let stdout = "";
    let stderr = "";
    let stdoutSeen = 0;
    let stderrSeen = 0;
    const limit = DEFAULT_BASH_OUTPUT_BYTES;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutSeen += text.length;
      if (stdout.length >= limit) return;
      const remaining = limit - stdout.length;
      stdout += text.length > remaining ? text.slice(0, remaining) : text;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrSeen += text.length;
      if (stderr.length >= limit) return;
      const remaining = limit - stderr.length;
      stderr += text.length > remaining ? text.slice(0, remaining) : text;
    });
    child.once("close", (code: number | null) => {
      const stdoutFinal =
        stdoutSeen > stdout.length
          ? `${stdout}\n…[truncated ${stdoutSeen - stdout.length} bytes]`
          : stdout;
      const stderrFinal =
        stderrSeen > stderr.length
          ? `${stderr}\n…[truncated ${stderrSeen - stderr.length} bytes]`
          : stderr;
      resolvePromise({
        exitCode: code,
        stdout: stdoutFinal,
        stderr: stderrFinal,
      });
    });
    child.once("error", (err: Error) => {
      resolvePromise({ error: err.message });
    });
  });
}
