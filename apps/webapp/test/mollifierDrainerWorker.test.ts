import { describe, expect, it } from "vitest";
import { MollifierConfigurationError } from "~/v3/mollifier/mollifierDrainer.server";
import { initMollifierDrainerWorker } from "~/v3/mollifierDrainerWorker.server";

// Pins the error-classification policy inside the bootstrap's catch:
// deterministic misconfig errors propagate (so a deploy fails loud
// rather than silently disabling the drainer), and anything else is
// logged-and-swallowed (so a transient Redis blip during boot doesn't
// take the whole webapp down). The corresponding production-path
// integration is the call at `entry.server.tsx`: a sync throw out of
// `initMollifierDrainerWorker` propagates to the module top level
// BEFORE `process.on("uncaughtException", ...)` is registered, so Node
// crashes with a stack trace and exit code 1 — which is exactly what we
// want from the orchestrator's health-check perspective.
describe("initMollifierDrainerWorker error classification", () => {
  it("rethrows MollifierConfigurationError so the process can crash on misconfig", () => {
    const misconfig = new MollifierConfigurationError(
      "TRIGGER_MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS must be at least 1000ms below GRACEFUL_SHUTDOWN_TIMEOUT",
    );

    expect(() =>
      initMollifierDrainerWorker({
        isEnabled: () => true,
        getDrainer: () => {
          throw misconfig;
        },
      }),
    ).toThrow(MollifierConfigurationError);
  });

  it("rethrows when the error carries the marker name even if instanceof fails (dev-realm hot-reload fallback)", () => {
    // Simulate the cross-realm case where the consumer's instanceof
    // check sees a different class instance from the one the throw
    // site used. The bootstrap's `.name === "MollifierConfigurationError"`
    // fallback must catch this so dev hot-reload doesn't silently
    // suppress misconfig errors.
    const cousin = new Error("buffer not initialised");
    cousin.name = "MollifierConfigurationError";

    expect(() =>
      initMollifierDrainerWorker({
        isEnabled: () => true,
        getDrainer: () => {
          throw cousin;
        },
      }),
    ).toThrow(cousin);
  });

  it("swallows non-configuration errors so transient init failures don't take the webapp down", () => {
    expect(() =>
      initMollifierDrainerWorker({
        isEnabled: () => true,
        getDrainer: () => {
          throw new Error("transient redis blip during buffer init");
        },
      }),
    ).not.toThrow();
  });

  it("is a no-op when the drainer is disabled for this replica", () => {
    let factoryCalled = false;
    initMollifierDrainerWorker({
      isEnabled: () => false,
      getDrainer: () => {
        factoryCalled = true;
        return null;
      },
    });
    expect(factoryCalled).toBe(false);
  });
});
