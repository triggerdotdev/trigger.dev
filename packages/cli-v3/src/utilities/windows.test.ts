import { afterEach, describe, expect, it } from "vitest";
import { truncateMessage } from "./windows.js";

const originalIsTTY = process.stdout.isTTY;
const originalColumns = process.stdout.columns;

function mockStdout(options: { isTTY: boolean; columns?: number | undefined }) {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: options.isTTY,
  });

  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: options.columns,
  });
}

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalIsTTY,
  });

  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: originalColumns,
  });
});

describe("truncateMessage", () => {
  it("returns the original message when stdout is not a TTY", () => {
    mockStdout({ isTTY: false, columns: undefined });

    const message = "a".repeat(500);

    expect(truncateMessage(message)).toBe(message);
  });

  it("returns the original message when stdout has no columns", () => {
    mockStdout({ isTTY: true, columns: undefined });

    const message = "a".repeat(500);

    expect(truncateMessage(message)).toBe(message);
  });

  it("does not truncate short messages", () => {
    expect(truncateMessage("hello", 20)).toBe("hello");
  });

  it("truncates long plain messages", () => {
    expect(truncateMessage("hello world", 12)).toBe("hell...");
  });

  it("truncates ANSI-colored messages without counting escape codes", () => {
    const message = "\x1b[31mhello world\x1b[39m";

    expect(truncateMessage(message, 12)).toBe("\x1b[31mhell\x1b[0m...");
  });

  it("preserves terminal hyperlink escapes when truncating", () => {
    const open = "\u001b]8;;https://trigger.dev\u0007";
    const close = "\u001b]8;;\u0007";
    const message = `${open}hello world${close}`;

    expect(truncateMessage(message, 12)).toBe(`${open}hell${close}...`);
  });
});
