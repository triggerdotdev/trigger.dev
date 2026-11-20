import { log, spinner as clackSpinner } from "@clack/prompts";
import { isCI, isWindows as stdEnvIsWindows } from "std-env";

const isWindows = stdEnvIsWindows;

// Removes ANSI escape sequences to get actual visible length
function getVisibleLength(str: string): number {
  return (
    str
      // Remove terminal hyperlinks: \u001b]8;;URL\u0007TEXT\u001b]8;;\u0007
      .replace(/\u001b]8;;[^\u0007]*\u0007/g, "")
      // Remove standard ANSI escape sequences (colors, cursor movement, etc.)
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").length
  );
}

function truncateMessage(msg: string, maxLength?: number): string {
  const terminalWidth = maxLength ?? process.stdout.columns ?? 80;
  const availableWidth = terminalWidth - 5; // Reserve some space for the spinner and padding
  const visibleLength = getVisibleLength(msg);

  if (visibleLength <= availableWidth) {
    return msg;
  }

  // We need to truncate based on visible characters, but preserve ANSI sequences
  // Simple approach: truncate character by character until we fit
  let truncated = msg;
  while (getVisibleLength(truncated) > availableWidth - 3) {
    truncated = truncated.slice(0, -1);
  }

  return truncated + "...";
}

const wrappedClackSpinner = () => {
  let currentMessage = "";
  let isActive = false;

  const handleResize = () => {
    if (isActive && currentMessage) {
      spinner.message(truncateMessage(currentMessage));
    }
  };

  const spinner = clackSpinner();

  return {
    start: (msg?: string): void => {
      currentMessage = msg ?? "";
      isActive = true;
      process.stdout.on("resize", handleResize);
      spinner.start(truncateMessage(currentMessage));
    },
    stop: (msg?: string, code?: number): void => {
      process.stdout.off("resize", handleResize);

      if (!isActive) {
        // Spinner was never started, just display the message
        if (msg) {
          log.message(msg);
        }
        return;
      }

      isActive = false;
      spinner.stop(truncateMessage(msg ?? ""), code);
    },
    message: (msg?: string): void => {
      currentMessage = msg ?? "";

      if (!isActive) {
        // Spinner was never started, just display the message
        if (msg) {
          log.message(msg);
        }
        return;
      }

      spinner.message(truncateMessage(currentMessage));
    },
  };
};

// This will become unecessary with the next clack release, the bug was fixed here:
// https://github.com/natemoo-re/clack/pull/182
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

const plainSpinner = () => ({
  start: (msg?: string): void => {
    console.log(msg ?? "");
  },
  stop: (msg?: string, code?: number): void => {
    if (msg) console.log(msg ?? "");
  },
  message: (msg?: string): void => {
    if (msg) console.log(msg ?? "");
  },
});

export const spinner = (options: { plain?: boolean } = { plain: false }) =>
  isPlainOutput(outputEnv(options.plain))
    ? plainSpinner()
    : isWindows
      ? ballmerSpinner()
      : wrappedClackSpinner();

export type OutputEnv = { plain: boolean; ci: boolean; tty: boolean };

export function outputEnv(plain = false): OutputEnv {
  return { plain, ci: isCI, tty: Boolean(process.stdout.isTTY) };
}

export function isPlainOutput(env: OutputEnv): boolean {
  return env.plain || env.ci || !env.tty;
}
