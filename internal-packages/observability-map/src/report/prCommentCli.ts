import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MapReport } from "../score.js";
import {
  hasDelta,
  renderPrComment,
  renderResolvedComment,
  renderScanFailedComment,
  type CommitContext,
} from "./prComment.js";

/** Where output goes. Injectable so tests can read it without spawning a process. */
export type Io = { out: (s: string) => void; err: (s: string) => void };

const processIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** Raises a message naming the file rather than letting an unreadable path or malformed JSON surface
 * as a stack trace. */
function readReport(path: string, label: string): MapReport {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${label}: ${path}`);
  }
  try {
    return JSON.parse(raw) as MapReport;
  } catch {
    throw new Error(`${label} is not valid JSON: ${path}`);
  }
}

/** An `--opt=value` argument, last one winning. An empty value reads as absent, since that is what an
 * unset workflow expression interpolates to. */
function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const values = args.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
  return values.filter(Boolean).pop();
}

/**
 * The commit the caller says this comment is for. Half a pair is rejected rather than dropped, since a
 * comment silently missing the line it was supposed to gain is the failure nobody would notice.
 */
function commitFrom(args: string[]): CommitContext | undefined {
  const sha = flag(args, "commit-sha");
  const url = flag(args, "commit-url");
  if (sha && url) return { sha, url };
  if (sha || url) throw new Error("--commit-sha and --commit-url have to be given together");
  return undefined;
}

/**
 * `-` or a missing second arg means no base, which is what the CI job falls back to when the base scan
 * failed, so the comment still renders rather than the job going red.
 *
 * Empty output means "post nothing". `--existing-comment` is how the workflow says a comment from an
 * earlier push is already there, so with the delta gone that comment is replaced with a resolved state
 * rather than left standing. `--scan-failed` and `--resolved` take no report at all, for a head scan
 * that produced nothing to read and for a run where the watched paths did not move.
 */
export function main(argv: string[], io: Io = processIo): number {
  const args = argv.slice(2);
  const scanFailed = args.includes("--scan-failed");
  const resolved = args.includes("--resolved");
  const existingComment = args.includes("--existing-comment");
  const positional = args.filter((a) => !a.startsWith("--"));
  const headPath = positional[0];
  const basePath = positional[1];

  /**
   * The marker has to be the document's first line or the workflow's lookup cannot find the comment it
   * left, and every later push posts a new one instead of updating it. `--out` keeps stdout free for
   * whatever a tool decides to announce, the same reason `src/cli.ts` has it. An empty write is a real
   * outcome and not a failure: it is how "post nothing" reaches the workflow's `-s` check.
   */
  const outPath = flag(args, "out");
  const write = (text: string) => {
    if (outPath === undefined) {
      if (text) io.out(text);
      return;
    }
    writeFileSync(outPath, text);
  };

  let commit: CommitContext | undefined;
  try {
    commit = commitFrom(args);
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (scanFailed) {
    write(`${renderScanFailedComment(commit)}\n`);
    return 0;
  }

  if (resolved) {
    write(`${renderResolvedComment(commit)}\n`);
    return 0;
  }

  if (!headPath) {
    io.err("usage: prCommentCli.ts <head.json> [base.json|-] [--existing-comment]\n");
    return 1;
  }

  let head: MapReport;
  let base: MapReport | null;
  try {
    head = readReport(headPath, "head report");
    base = !basePath || basePath === "-" ? null : readReport(basePath, "base report");
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (hasDelta(head, base)) {
    write(`${renderPrComment(head, base, commit)}\n`);
    return 0;
  }
  write(existingComment ? `${renderResolvedComment(commit)}\n` : "");
  return 0;
}

// Only when run as a program. Importing the module, which the tests do, must not read a file.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv);
