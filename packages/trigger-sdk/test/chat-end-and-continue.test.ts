import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

describe("chat.endAndContinue", () => {
  it("rejects calls outside a custom agent run", async () => {
    await expect(chat.endAndContinue()).rejects.toThrow(
      "chat.endAndContinue() can only be called from inside a chat.customAgent() run"
    );
  });
});
