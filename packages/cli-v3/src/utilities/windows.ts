import { log, spinner as clackSpinner } from "@clack/prompts";
import { isWindows as stdEnvIsWindows } from "std-env";

export const isWindows = stdEnvIsWindows;

export function escapeImportPath(path: string) {
  return isWindows ? path.replaceAll("\\", "\\\\") : path;
}

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

// Matches a single ANSI escape sequence (terminal hyperlink or CSI sequence)
// at the regex's lastIndex. Used to skip escape codes while counting visible
// characters during truncation.
const ANSI_SEQUENCE = /\u001b]8;;[^\u0007]*\u0007|\x1b\[[0-9;]*[a-zA-Z]/y;

function truncateMessage(msg: string, maxLength?: number): string {
  // When there is no explicit max and no TTY (e.g. a non-interactive CI shell),
  // `process.stdout.columns` is undefined and there is no terminal width to fit
  // to, so leave the message untouched. This also avoids the work below on the
  // large messages emitted during a deploy.
  const terminalWidth = maxLength ?? process.stdout.columns;
  if (terminalWidth == null) {
    return msg;
  }

  const availableWidth = terminalWidth - 5; // Reserve some space for the spinner and padding
  const visibleLength = getVisibleLength(msg);

  if (visibleLength <= availableWidth) {
    return msg;
  }

  // Truncate based on visible characters while preserving ANSI sequences, in a
  // single forward pass. The previous implementation removed one character at a
  // time and re-scanned the whole string with two regexes on every iteration --
  // O(n^2) -- which pegged the CPU for minutes on the large messages a deploy
  // emits, especially in CI where the message isn't a short live-updating line.
  const limit = Math.max(availableWidth - 3, 0);
  let result = "";
  let visible = 0;
  let index = 0;

  while (index < msg.length && visible < limit) {
    ANSI_SEQUENCE.lastIndex = index;
    const match = ANSI_SEQUENCE.exec(msg);

    if (match) {
      // Escape sequences don't count toward the visible width.
      result += match[0];
      index += match[0].length;
    } else {
      result += msg[index];
      visible += 1;
      index += 1;
    }
  }

  return result + "...";
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

// This will become unecessary with the next clack release, the bug was fixed here:
// https://github.com/natemoo-re/clack/pull/182
export const spinner = (options: { plain?: boolean } = { plain: false }) =>
  options.plain ? plainSpinner() : isWindows ? ballmerSpinner() : wrappedClackSpinner();
