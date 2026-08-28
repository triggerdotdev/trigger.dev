import { describe, expect, it } from "vitest";
import { registerAskAiHost, requestAskAi } from "./askAiOpenRequest";

describe("the Ask AI open-request bridge", () => {
  it("reports no host until one registers", () => {
    expect(requestAskAi()).toBe(false);

    const off = registerAskAiHost(() => {});
    expect(requestAskAi()).toBe(true);

    off();
    expect(requestAskAi()).toBe(false);
  });

  it("hands the host the question it was asked for", () => {
    const asked: Array<string | undefined> = [];
    const off = registerAskAiHost((question) => asked.push(question));

    requestAskAi("how do I deploy?");
    requestAskAi();

    expect(asked).toEqual(["how do I deploy?", undefined]);
    off();
  });
});
