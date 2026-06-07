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
  // If not a TTY and no explicit length provided, don't truncate
  if (!process.stdout.isTTY && maxLength === undefined) {
    return msg;
  }

  const terminalWidth = maxLength ?? process.stdout.columns ?? 80;
  const availableWidth = terminalWidth - 5; // Reserve some space for the spinner and padding
  const visibleLength = getVisibleLength(msg);

  if (visibleLength <= availableWidth) {
    return msg;
  }

  // We need to truncate based on visible characters, but preserve ANSI sequences
  const targetLength = availableWidth - 3;
  let visibleCount = 0;
  let result = "";

  const ansiRegex = /\x1b\]8;;[^\x07]*\x07|\x1b\[[0-9;]*[a-zA-Z]/g;
  let lastIndex = 0;
  let match;

  while ((match = ansiRegex.exec(msg)) !== null) {
    const textPart = msg.slice(lastIndex, match.index);
    const textPartVisibleLength = textPart.length;

    if (visibleCount + textPartVisibleLength > targetLength) {
      if (visibleCount <= targetLength) {
        result += textPart.slice(0, targetLength - visibleCount) + "...";
        visibleCount = targetLength + 1; // Mark as done
      }
      result += match[0];
    } else {
      if (visibleCount <= targetLength) {
        result += textPart + match[0];
        visibleCount += textPartVisibleLength;
      } else {
        result += match[0];
      }
    }
    lastIndex = ansiRegex.lastIndex;
  }

  if (visibleCount <= targetLength) {
    const remainingText = msg.slice(lastIndex);
    if (visibleCount + remainingText.length > targetLength) {
      result += remainingText.slice(0, targetLength - visibleCount) + "...";
    } else {
      result += remainingText;
    }
  }

  return result;
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
