import { readFileSync } from "node:fs";
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

/** Reads and parses one report file, raising a message naming the file rather than letting an
 * unreadable path or malformed JSON surface as a stack trace. */
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

/** An `--opt=value` argument, last one winning. An empty value reads as absent, since that is what
 * an unset workflow expression interpolates to. */
function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const values = args.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
  return values.filter(Boolean).pop();
}

/**
 * The commit the caller says this comment is for. Half a pair is rejected rather than dropped: it
 * can only come from an edit to the workflow that passes one and not the other, and a comment
 * silently missing the line it was supposed to gain is the failure nobody would notice.
 */
function commitFrom(args: string[]): CommitContext | undefined {
  const sha = flag(args, "commit-sha");
  const url = flag(args, "commit-url");
  if (sha && url) return { sha, url };
  if (sha || url) throw new Error("--commit-sha and --commit-url have to be given together");
  return undefined;
}

/**
 * `-` or a missing second arg means no base: the CI job falls back to this when the base scan
 * itself failed, so the comment still renders rather than the job going red.
 *
 * Empty output means "post nothing". The job only comments when the pull request moves the report,
 * and `--existing-comment` is how the workflow says a comment from an earlier push is already on
 * the pull request: with the delta gone, that comment is replaced with a resolved state rather
 * than left standing with findings that no longer exist.
 *
 * `--scan-failed` takes no report and prints the stale-report comment, for the case where the head
 * scan produced nothing to read. `--resolved` takes no report either and prints the resolved state
 * outright, for the case where the workflow knows there is nothing to compare: the paths the report
 * watches did not move in this pull request at all, so nothing was scanned, and the comment an
 * earlier push left has to stop showing findings that are no longer in the diff.
 *
 * `--commit-sha` and `--commit-url` are the commit every comment above is rendered as of.
 */
export function main(argv: string[], io: Io = processIo): number {
  const args = argv.slice(2);
  const scanFailed = args.includes("--scan-failed");
  const resolved = args.includes("--resolved");
  const existingComment = args.includes("--existing-comment");
  const positional = args.filter((a) => !a.startsWith("--"));
  const headPath = positional[0];
  const basePath = positional[1];

  let commit: CommitContext | undefined;
  try {
    commit = commitFrom(args);
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (scanFailed) {
    io.out(`${renderScanFailedComment(commit)}\n`);
    return 0;
  }

  if (resolved) {
    io.out(`${renderResolvedComment(commit)}\n`);
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
    io.out(`${renderPrComment(head, base, commit)}\n`);
    return 0;
  }
  if (existingComment) {
    io.out(`${renderResolvedComment(commit)}\n`);
  }
  return 0;
}

// Only when run as a program. Importing the module, which the tests do, must not read a file.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv);
