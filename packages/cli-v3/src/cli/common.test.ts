import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { commonOptions } from "./common.js";

describe("commonOptions", () => {
  it("leaves the API URL unset when it is not explicitly provided", () => {
    const command = commonOptions(new Command());

    command.parse(["node", "trigger"]);

    expect(command.opts().apiUrl).toBeUndefined();
  });

  it("preserves an explicitly provided API URL", () => {
    const command = commonOptions(new Command());

    command.parse(["node", "trigger", "--api-url", "https://trigger.example.com"]);

    expect(command.opts().apiUrl).toBe("https://trigger.example.com");
  });
});
