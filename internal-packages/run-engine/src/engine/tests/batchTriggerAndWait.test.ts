import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  assertNonNullable,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { EventBusEventArgs } from "../eventBus.js";

describe("RunEngine batchTriggerAndWait", () => {
  //todo batchTriggerAndWait tests
  test("empty test", async () => {});
});
