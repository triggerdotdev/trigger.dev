import { log, spinner as clackSpinner } from "@clack/prompts";
import { isWindows as stdEnvIsWindows } from "std-env";

export const isWindows = stdEnvIsWindows;

export function escapeImportPath(path: string) {
  return isWindows ? path.replaceAll("\\", "\\\\") : path;
}

const terminalHyperlinkPattern = /\u001b]8;;[^\u0007]*\u0007/y;
const ansiEscapePattern = /\x1b\[[0-9;]*[a-zA-Z]/y;
const terminalHyperlinkClose = "\u001b]8;;\u0007";
const ansiReset = "\u001b[0m";
const ansiResetCodes = new Set([0, 22, 23, 24, 25, 27, 28, 29, 39, 49, 54, 55, 59]);

function updateAnsiState(sequence: string, hasActiveSgr: boolean): boolean {
  if (!sequence.endsWith("m")) {
    return hasActiveSgr;
  }

  const rawCodes = sequence.slice(2, -1);
  const codes = rawCodes === "" ? [0] : rawCodes.split(";").map(Number);

  return codes.some((code) => !ansiResetCodes.has(code));
}

// Removes ANSI escape sequences to get actual visible length
function getVisibleLength(str: string): number {
  let visibleLength = 0;

  for (let index = 0; index < str.length; ) {
    terminalHyperlinkPattern.lastIndex = index;
    const terminalHyperlinkMatch = terminalHyperlinkPattern.exec(str);

    if (terminalHyperlinkMatch) {
      index += terminalHyperlinkMatch[0].length;
      continue;
    }

    ansiEscapePattern.lastIndex = index;
    const ansiEscapeMatch = ansiEscapePattern.exec(str);

    if (ansiEscapeMatch) {
      index += ansiEscapeMatch[0].length;
      continue;
    }

    visibleLength += 1;
    index += 1;
  }

  return visibleLength;
}

export function truncateMessage(msg: string, maxLength?: number): string {
  if (maxLength === undefined && (!process.stdout.isTTY || process.stdout.columns == null)) {
    return msg;
  }

  const terminalWidth = maxLength ?? process.stdout.columns ?? 80;
  const availableWidth = terminalWidth - 5; // Reserve some space for the spinner and padding
  const visibleLength = getVisibleLength(msg);

  if (visibleLength <= availableWidth) {
    return msg;
  }

  const maxVisibleLength = availableWidth - 3;

  // We need to truncate based on visible characters, but preserve ANSI sequences
  let truncated = "";
  let truncatedVisibleLength = 0;
  let hasActiveSgr = false;
  let hasActiveHyperlink = false;

  for (let index = 0; index < msg.length && truncatedVisibleLength < maxVisibleLength; ) {
    terminalHyperlinkPattern.lastIndex = index;
    const terminalHyperlinkMatch = terminalHyperlinkPattern.exec(msg);

    if (terminalHyperlinkMatch) {
      const sequence = terminalHyperlinkMatch[0];
      truncated += sequence;
      hasActiveHyperlink = sequence !== terminalHyperlinkClose;
      index += sequence.length;
      continue;
    }

    ansiEscapePattern.lastIndex = index;
    const ansiEscapeMatch = ansiEscapePattern.exec(msg);

    if (ansiEscapeMatch) {
      const sequence = ansiEscapeMatch[0];
      truncated += sequence;
      hasActiveSgr = updateAnsiState(sequence, hasActiveSgr);
      index += sequence.length;
      continue;
    }

    truncated += msg[index];
    truncatedVisibleLength += 1;
    index += 1;

    if (truncatedVisibleLength === maxVisibleLength) {
      while (index < msg.length) {
        terminalHyperlinkPattern.lastIndex = index;
        const trailingTerminalHyperlinkMatch = terminalHyperlinkPattern.exec(msg);

        if (trailingTerminalHyperlinkMatch) {
          const sequence = trailingTerminalHyperlinkMatch[0];
          truncated += sequence;
          hasActiveHyperlink = sequence !== terminalHyperlinkClose;
          index += sequence.length;
          continue;
        }

        ansiEscapePattern.lastIndex = index;
        const trailingAnsiEscapeMatch = ansiEscapePattern.exec(msg);

        if (trailingAnsiEscapeMatch) {
          const sequence = trailingAnsiEscapeMatch[0];
          truncated += sequence;
          hasActiveSgr = updateAnsiState(sequence, hasActiveSgr);
          index += sequence.length;
          continue;
        }

        break;
      }
    }
  }

  if (hasActiveHyperlink) {
    truncated += terminalHyperlinkClose;
  }

  if (hasActiveSgr) {
    truncated += ansiReset;
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
