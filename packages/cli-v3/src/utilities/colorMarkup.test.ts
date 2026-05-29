import { describe, it, expect } from "vitest";
import chalk from "chalk";
import { applyColorMarkup } from "./colorMarkup.js";

// Force chalk to produce color codes in tests
chalk.level = 3;

describe("applyColorMarkup", () => {
  it("returns plain text when no markup is present", () => {
    expect(applyColorMarkup("Hello world")).toBe("Hello world");
  });

  it("applies fallback style to plain text when provided", () => {
    expect(applyColorMarkup("Hello", chalk.bold)).toBe(chalk.bold("Hello"));
  });

  it("applies a single color tag", () => {
    expect(applyColorMarkup("{red}error{/red}")).toBe(chalk.red("error"));
  });

  it("applies color to a portion of text", () => {
    const result = applyColorMarkup("Status: {green}OK{/green}");
    expect(result).toBe("Status: " + chalk.green("OK"));
  });

  it("applies multiple color regions", () => {
    const result = applyColorMarkup("{red}bad{/red} and {green}good{/green}");
    expect(result).toBe(chalk.red("bad") + " and " + chalk.green("good"));
  });

  it("applies bold tag", () => {
    expect(applyColorMarkup("{bold}important{/bold}")).toBe(chalk.bold("important"));
  });

  it("applies fallback to non-tagged text only", () => {
    const result = applyColorMarkup("Please {red}upgrade{/red} now", chalk.bold);
    expect(result).toBe(chalk.bold("Please ") + chalk.red("upgrade") + chalk.bold(" now"));
  });

  it("passes through invalid tag names as literal text", () => {
    expect(applyColorMarkup("Hello {foo}world{/foo}")).toBe("Hello {foo}world{/foo}");
  });

  it("passes through braces with non-tag content", () => {
    expect(applyColorMarkup("Use {curly} braces")).toBe("Use {curly} braces");
  });

  it("falls back on unclosed tag", () => {
    const result = applyColorMarkup("{red}oops", chalk.bold);
    expect(result).toBe(chalk.bold("{red}oops"));
  });

  it("falls back on mismatched close tag", () => {
    const result = applyColorMarkup("{red}text{/green}", chalk.bold);
    expect(result).toBe(chalk.bold("{red}text{/green}"));
  });

  it("falls back on nested tags", () => {
    const result = applyColorMarkup("{red}{bold}nested{/bold}{/red}", chalk.bold);
    expect(result).toBe(chalk.bold("{red}{bold}nested{/bold}{/red}"));
  });

  it("falls back on close tag without open", () => {
    const result = applyColorMarkup("text{/red}");
    expect(result).toBe("text{/red}");
  });

  it("handles empty string", () => {
    expect(applyColorMarkup("")).toBe("");
  });

  it("handles tag with empty content", () => {
    expect(applyColorMarkup("{red}{/red}")).toBe(chalk.red(""));
  });

  it("handles all valid color tags", () => {
    const tags = [
      "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray",
      "redBright", "greenBright", "yellowBright", "blueBright",
      "magentaBright", "cyanBright", "whiteBright",
    ];
    for (const tag of tags) {
      const result = applyColorMarkup(`{${tag}}test{/${tag}}`);
      const expected = (chalk as Record<string, (s: string) => string>)[tag]("test");
      expect(result).toBe(expected);
    }
  });

  it("handles text with only braces but no valid tags", () => {
    expect(applyColorMarkup("{} and {/}")).toBe("{} and {/}");
  });
});
