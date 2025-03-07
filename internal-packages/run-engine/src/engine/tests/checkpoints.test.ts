//todo checkpoint tests
import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  assertNonNullable,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { EventBusEventArgs } from "../eventBus.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine checkpoints", () => {
  //todo checkpoint tests
  test("empty test", async () => {});
});
