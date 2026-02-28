import { createJsonErrorObject } from "../src/v3/errors.js";
import type { TaskRunError } from "../src/v3/schemas/common.js";

describe("createJsonErrorObject", () => {
  it("should filter internal framework noise from error stack traces", () => {
    const taskRunError: TaskRunError = {
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "Network error occurred",
      stackTrace: `Error: Network error occurred
    at fetchData (file:///src/trigger/utils/helper.ts:4:9)
    at processResponse (file:///src/trigger/utils/helper.ts:9:10)
    at parseResult (file:///src/trigger/utils/helper.ts:14:10)
    at callAPI (file:///src/trigger/services/api.ts:6:10)
    at localHelper (file:///src/trigger/example.ts:7:10)
    at run (file:///src/trigger/example.ts:17:12)
    at _tracer.startActiveSpan.attributes (file:///.npm/_npx/f51a09bd0abf5f10/node_modules/@trigger.dev/core/src/v3/workers/taskExecutor.ts:445:38)
    at file:///.npm/_npx/f51a09bd0abf5f10/node_modules/@trigger.dev/core/src/v3/tracer.ts:137:24
    at AsyncLocalStorage.run (node:async_hooks:346:14)
    at AsyncLocalStorageContextManager.with (file:///.npm/_npx/f51a09bd0abf5f10/node_modules/@opentelemetry/context-async-hooks/src/AsyncLocalStorageContextManager.ts:40:36)`,
    };

    const jsonError = createJsonErrorObject(taskRunError);

    // Should preserve user stack traces
    expect(jsonError.stackTrace).toContain(
      "at fetchData (file:///src/trigger/utils/helper.ts:4:9)"
    );
    expect(jsonError.stackTrace).toContain(
      "at processResponse (file:///src/trigger/utils/helper.ts:9:10)"
    );
    expect(jsonError.stackTrace).toContain(
      "at parseResult (file:///src/trigger/utils/helper.ts:14:10)"
    );
    expect(jsonError.stackTrace).toContain("at callAPI (file:///src/trigger/services/api.ts:6:10)");
    expect(jsonError.stackTrace).toContain("at localHelper (file:///src/trigger/example.ts:7:10)");
    expect(jsonError.stackTrace).toContain("at run (file:///src/trigger/example.ts:17:12)");

    // Should filter framework noise
    expect(jsonError.stackTrace).not.toContain("_tracer.startActiveSpan.attributes");
    expect(jsonError.stackTrace).not.toContain("taskExecutor.ts");
    expect(jsonError.stackTrace).not.toContain("tracer.ts");
    expect(jsonError.stackTrace).not.toContain("AsyncLocalStorage.run");
    expect(jsonError.stackTrace).not.toContain("AsyncLocalStorageContextManager");
    expect(jsonError.stackTrace).not.toContain("node_modules/@trigger.dev/core");
    expect(jsonError.stackTrace).not.toContain(".npm/_npx");
  });
});
