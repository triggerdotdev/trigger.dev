import { describe, expect, it } from "vitest";
import { gateAlertJob } from "./gateAlertJob";

describe("gateAlertJob", () => {
  it("acks without running the handler when alerts are disabled", async () => {
    let calls = 0;
    const handler = gateAlertJob(false, async () => {
      calls++;
      throw new Error("must not run");
    });

    await expect(handler({ payload: { alertId: "a" } })).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("runs the handler when alerts are enabled", async () => {
    const seen: string[] = [];
    const handler = gateAlertJob(true, async ({ payload }: { payload: { alertId: string } }) => {
      seen.push(payload.alertId);
    });

    await handler({ payload: { alertId: "a" } });
    expect(seen).toEqual(["a"]);
  });
});
