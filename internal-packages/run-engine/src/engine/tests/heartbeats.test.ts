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

describe("RunEngine", () => {
  //todo heartbeat coming through, updating the snapshot and then succeeding
  test("empty test", async () => {});

  //todo heartbeat failing and the run eventually failing with a system failure
});
