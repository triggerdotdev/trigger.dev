import { describe, expect, it } from "vitest";
import { SecretEnv } from "./secretEnv.js";

describe("SecretEnv", () => {
  // Catches: the caller's env object still holding the run's secrets after they are moved.
  it("moves the values out of the source env", () => {
    const source: Record<string, string> = { TRIGGER_RUN_TOKEN: "token", EMPTY: "" };

    const env = SecretEnv.takeFrom(source);

    expect(source).toEqual({});
    expect(env.toRecord()).toEqual({ TRIGGER_RUN_TOKEN: "token", EMPTY: "" });
  });

  // Catches: secrets left readable in the controller's memory after the attempt zeroes them.
  it("zeroes its buffers and holds nothing afterwards", () => {
    const env = SecretEnv.takeFrom({ TRIGGER_RUN_TOKEN: "token" });
    const buffers = (env as any).entries.map(([, value]: [string, Buffer]) => value) as Buffer[];

    env.zero();

    expect(buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect(env.toRecord()).toEqual({});
  });
});
