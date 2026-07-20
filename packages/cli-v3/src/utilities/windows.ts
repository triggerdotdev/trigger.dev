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

function truncateMessage(msg: string, maxLength?: number): string {
  // Non-TTY (CI): no spinner width to honor — skip truncation entirely.
  // Character-by-character truncation is O(n²) and hangs deploys on large graphs.
  if (maxLength === undefined && (!process.stdout.isTTY || !process.stdout.columns)) {
    return msg;
  }

  const terminalWidth = maxLength ?? process.stdout.columns ?? 80;
  const availableWidth = terminalWidth - 5; // Reserve some space for the spinner and padding
  const targetWidth = availableWidth - 3; // room for "..."
  const visibleLength = getVisibleLength(msg);

  if (visibleLength <= availableWidth) {
    return msg;
  }

  // Walk once, counting visible characters, and cut at the first overflow.
  // Preserve ANSI sequences so colors/links remain valid.
  let visible = 0;
  let i = 0;
  while (i < msg.length) {
    // OSC 8 hyperlinks: \u001b]8;;URL\u0007TEXT\u001b]8;;\u0007
    if (msg.startsWith("\u001b]8;;", i)) {
      const end = msg.indexOf("\u0007", i);
      if (end === -1) {
        break;
      }
      i = end + 1;
      continue;
    }
    // CSI sequences: \x1b[...X
    if (msg[i] === "\x1b" && msg[i + 1] === "[") {
      i += 2;
      while (i < msg.length && !/[a-zA-Z]/.test(msg[i]!)) {
        i++;
      }
      if (i < msg.length) {
        i++;
      }
      continue;
    }

    if (visible >= targetWidth) {
      return msg.slice(0, i) + "...";
    }
    visible++;
    i++;
  }

  return msg.slice(0, i) + "...";
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
