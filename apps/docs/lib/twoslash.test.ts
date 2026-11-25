import { describe, expect, it } from "vitest";
import { inferredImport } from "./twoslash";

const packages = [
  { pkg: "@trigger.dev/sdk", names: new Set(["task", "logger", "wait", "tasks"]) },
  { pkg: "@trigger.dev/sdk/ai", names: new Set(["chat", "ai"]) },
];

describe("inferredImport", () => {
  it("imports the SDK names a sample calls, grouped by package", () => {
    const code = `export const t = task({ id: "x", run: async () => { logger.info("hi"); await chat.agent({}); } });`;
    expect(inferredImport(code, packages)).toBe(
      `import { logger, task } from "@trigger.dev/sdk";\nimport { chat } from "@trigger.dev/sdk/ai";`
    );
  });

  it("skips samples that already import the SDK", () => {
    expect(inferredImport(`import { task } from "@trigger.dev/sdk";\ntask({})`, packages)).toBe(
      undefined
    );
  });

  it("skips names the sample declares or imports itself, and member calls", () => {
    const code = `import { logger } from "./log";\nconst wait = () => {};\nwait();\nlogger.info("x");\nfoo.task();`;
    expect(inferredImport(code, packages)).toBe(undefined);
  });
});
