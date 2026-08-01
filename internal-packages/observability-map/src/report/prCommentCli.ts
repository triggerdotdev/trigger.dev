import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MapReport } from "../score.js";
import { renderPrComment } from "./prComment.js";

/** Where output goes. Injectable so tests can read it without spawning a process. */
export type Io = { out: (s: string) => void; err: (s: string) => void };

const processIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** `-` or a missing second arg means no base: the CI job falls back to this when the base scan
 * itself failed, so the comment still renders rather than the job going red. */
export function main(argv: string[], io: Io = processIo): number {
  const args = argv.slice(2);
  const headPath = args[0];
  const basePath = args[1];

  if (!headPath) {
    io.err("usage: prCommentCli.ts <head.json> [base.json|-]\n");
    return 1;
  }

  const head = JSON.parse(readFileSync(headPath, "utf8")) as MapReport;
  const base: MapReport | null =
    !basePath || basePath === "-" ? null : JSON.parse(readFileSync(basePath, "utf8"));

  io.out(renderPrComment(head, base));
  io.out("\n");
  return 0;
}

// Only when run as a program. Importing the module, which the tests do, must not read a file.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv);
