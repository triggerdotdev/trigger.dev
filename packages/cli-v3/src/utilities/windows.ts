import { log, spinner as clackSpinner } from "@clack/prompts";
import { isWindows as stdEnvIsWindows } from "std-env";

export const isWindows = stdEnvIsWindows;

export function escapeImportPath(path: string) {
  return isWindows ? path.replaceAll("\\", "\\\\") : path;
}

const ballmerSpinner = () => ({
  start: (msg?: string): void => {
    log.step(msg ?? "");
  },
  stop: (msg?: string, code?: number): void => {
    log.message(msg ?? "");
  },
  message: (msg?: string): void => {
    log.message(msg ?? "");
  },
});

// This will become unecessary with the next clack release, the bug was fixed here:
// https://github.com/natemoo-re/clack/pull/182
export const spinner = () => (isWindows ? ballmerSpinner() : clackSpinner());
