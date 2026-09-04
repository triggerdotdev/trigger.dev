// The API error boundary must return success for a retryable failure ONLY when the engine proves the
// durable guard was armed before it (a WaitpointCompletionGuardArmedError). A pre-arm failure —
// including the guard's own enqueue failing — must propagate, because no durable owner exists yet.
// These drive the real helper with DI (no vi.mock of it): injected `isEnabled` + `completeWaitpoint`.
import { WaitpointCompletionGuardArmedError } from "@internal/run-engine";
import { describe, expect, it } from "vitest";
import { completeWaitpointWithGuard } from "~/v3/completeWaitpointWithGuard.server";

const econnreset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

describe("completeWaitpointWithGuard error boundary", () => {
  // Test 1: a pre-arm retryable failure (e.g. the guard's Redis enqueue itself failing) is NOT the
  // branded post-arm error, so it must propagate and the caller must not report success.
  it("propagates a pre-arm retryable failure and does not return success", async () => {
    const raw = econnreset();
    await expect(
      completeWaitpointWithGuard(
        { id: "wp_prearm" },
        {
          isEnabled: async () => true,
          completeWaitpoint: async () => {
            throw raw; // thrown before the guard was armed -> not branded
          },
        }
      )
    ).rejects.toBe(raw);
  });

  // Test 2: a retryable failure AFTER the guard is armed (branded) is suppressed; guard redelivery
  // will complete it, so the API returns success.
  it("returns success for a retryable failure after the guard was armed", async () => {
    const armed = new WaitpointCompletionGuardArmedError("wp_postarm", { cause: econnreset() });
    await expect(
      completeWaitpointWithGuard(
        { id: "wp_postarm" },
        {
          isEnabled: async () => true,
          completeWaitpoint: async () => {
            throw armed;
          },
        }
      )
    ).resolves.toBeUndefined();
  });

  // Armed but NOT retryable (e.g. validation): surface the original cause, never a silent success.
  it("surfaces the original cause when armed but the failure is not retryable", async () => {
    const cause = new Error("validation failed");
    const armed = new WaitpointCompletionGuardArmedError("wp_nonretry", { cause });
    await expect(
      completeWaitpointWithGuard(
        { id: "wp_nonretry" },
        {
          isEnabled: async () => true,
          completeWaitpoint: async () => {
            throw armed;
          },
        }
      )
    ).rejects.toBe(cause);
  });

  // Test 3: flag off is unchanged: the guard is never requested and every error propagates.
  it("flag off: never arms the guard and propagates every error", async () => {
    let observedArmGuard: boolean | undefined;
    const err = new Error("boom");
    await expect(
      completeWaitpointWithGuard(
        { id: "wp_off" },
        {
          isEnabled: async () => false,
          completeWaitpoint: async (a) => {
            observedArmGuard = a.armGuard;
            throw err;
          },
        }
      )
    ).rejects.toBe(err);
    expect(observedArmGuard).toBe(false);
  });

  it("flag off: a successful completion passes through", async () => {
    await expect(
      completeWaitpointWithGuard(
        { id: "wp_off_ok" },
        { isEnabled: async () => false, completeWaitpoint: async () => undefined }
      )
    ).resolves.toBeUndefined();
  });
});
