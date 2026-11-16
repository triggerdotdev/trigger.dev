import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every entropy source a module could draw from at import.
function spyOnRandomness() {
  return [
    vi.spyOn(crypto, "randomFillSync"),
    vi.spyOn(crypto, "randomBytes"),
    vi.spyOn(crypto, "randomUUID"),
    vi.spyOn(crypto.webcrypto, "getRandomValues"),
    vi.spyOn(globalThis.crypto, "getRandomValues"),
    vi.spyOn(Math, "random"),
  ];
}

function drawCount(spies: ReturnType<typeof spyOnRandomness>) {
  return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

describe("getMachineId", () => {
  let savedMachineId: string | undefined;

  beforeEach(() => {
    savedMachineId = process.env.TRIGGER_MACHINE_ID;
    delete process.env.TRIGGER_MACHINE_ID;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedMachineId === undefined) delete process.env.TRIGGER_MACHINE_ID;
    else process.env.TRIGGER_MACHINE_ID = savedMachineId;
  });

  // Catches: the machine id (and nanoid's pool) being drawn at import, so a process
  // restored from a warm start reuses them.
  it("draws no randomness at import and keeps the id once generated", async () => {
    const spies = spyOnRandomness();

    const { getMachineId } = await import("../src/v3/otel/machineId.js");
    expect(drawCount(spies)).toBe(0);

    const id = getMachineId();
    expect(id).toMatch(/^machine_/);
    expect(drawCount(spies)).toBeGreaterThan(0);
    expect(getMachineId()).toBe(id);
  });

  it("uses TRIGGER_MACHINE_ID when it is set", async () => {
    process.env.TRIGGER_MACHINE_ID = "machine_from_env";

    const { getMachineId } = await import("../src/v3/otel/machineId.js");

    expect(getMachineId()).toBe("machine_from_env");
  });
});
