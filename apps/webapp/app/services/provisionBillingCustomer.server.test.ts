import type {
  BillingController,
  BillingCustomer,
  BillingCustomerError,
  ProvisionBillingCustomerParams,
  ProvisionBillingCustomerResult,
} from "@trigger.dev/billing";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  PROVISION_MAX_ATTEMPTS,
  provisionBillingCustomerForNewOrg,
  type NewOrgProvisionDependencies,
} from "./provisionBillingCustomer.server";

type Outcome = () => ResultAsync<ProvisionBillingCustomerResult, BillingCustomerError>;

const created: Outcome = () =>
  okAsync({ organizationId: "org_1", billingCustomerId: "cus_1", outcome: "created" as const });

const never: Outcome = () => new ResultAsync(new Promise(() => {}));

function harness(outcomes: Outcome[], options: { usingPlugin?: () => Promise<boolean> } = {}) {
  const calls: ProvisionBillingCustomerParams[] = [];
  const deleted: string[] = [];

  const controller: BillingController = {
    isUsingPlugin: options.usingPlugin ?? (async () => true),
    getCustomer(): ResultAsync<BillingCustomer | null, BillingCustomerError> {
      return okAsync(null);
    },
    provisionCustomer(params) {
      calls.push(params);
      return outcomes[Math.min(calls.length - 1, outcomes.length - 1)]();
    },
  };

  const deps: NewOrgProvisionDependencies = {
    enabled: true,
    controller,
    deleteOrganization: async (id) => {
      deleted.push(id);
    },
  };

  return { deps, calls, deleted };
}

function run(deps: NewOrgProvisionDependencies) {
  return provisionBillingCustomerForNewOrg("org_1", deps).then(
    () => "ok" as const,
    (error: Error) => error
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("provisionBillingCustomerForNewOrg", () => {
  it("does nothing when billing is not enabled", async () => {
    const { deps, calls, deleted } = harness([created]);

    expect(await run({ ...deps, enabled: false })).toBe("ok");
    expect(calls).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("blocks until the customer is provisioned and keeps the org", async () => {
    const { deps, calls, deleted } = harness([created]);

    expect(await run(deps)).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].organizationId).toBe("org_1");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(deleted).toHaveLength(0);
  });

  it("accepts an org that was already provisioned", async () => {
    const { deps, deleted } = harness([
      () =>
        okAsync({
          organizationId: "org_1",
          billingCustomerId: "cus_1",
          outcome: "already_provisioned" as const,
        }),
    ]);

    expect(await run(deps)).toBe("ok");
    expect(deleted).toHaveLength(0);
  });

  it("fails closed when billing is enabled but the plugin did not load", async () => {
    const { deps, calls, deleted } = harness([created], { usingPlugin: async () => false });

    expect(await run(deps)).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
    expect(deleted).toEqual(["org_1"]);
  });

  it("keeps the org when the plugin did not load and the policy is skip", async () => {
    const { deps, deleted } = harness([created], { usingPlugin: async () => false });

    expect(await run({ ...deps, notConfiguredPolicy: "skip" })).toBe("ok");
    expect(deleted).toHaveLength(0);
  });

  it("ends at the deadline even when plugin initialization never settles", async () => {
    const { deps, calls, deleted } = harness([created], {
      usingPlugin: () => new Promise(() => {}),
    });

    const settled = run({ ...deps, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(deleted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(await settled).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
    expect(deleted).toEqual(["org_1"]);
  });

  it("rolls back when checking the plugin throws", async () => {
    const { deps, deleted } = harness([created], {
      usingPlugin: async () => {
        throw new Error("boom");
      },
    });

    expect(await run(deps)).toBeInstanceOf(Error);
    expect(deleted).toEqual(["org_1"]);
  });

  it("retries a transient failure with exponential backoff, then succeeds", async () => {
    const { deps, calls, deleted } = harness([
      () => errAsync("upstream_unavailable"),
      () => errAsync("internal"),
      created,
    ]);

    const settled = run(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(3);

    expect(await settled).toBe("ok");
    expect(deleted).toHaveLength(0);
  });

  it("retries a provisioning call that throws like a transient failure", async () => {
    const { deps, calls } = harness([
      () => new ResultAsync(Promise.reject(new Error("socket hang up"))),
      created,
    ]);

    const settled = run(deps);
    await vi.advanceTimersByTimeAsync(200);

    expect(await settled).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("retries an in_progress outcome instead of treating it as done", async () => {
    const { deps, calls } = harness([
      () =>
        okAsync({
          organizationId: "org_1",
          billingCustomerId: null,
          outcome: "in_progress" as const,
        }),
      created,
    ]);

    const settled = run(deps);
    await vi.advanceTimersByTimeAsync(200);

    expect(await settled).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("deletes the org and fails creation once retries are exhausted", async () => {
    const { deps, calls, deleted } = harness([() => errAsync("upstream_unavailable")]);

    const settled = run(deps);
    await vi.advanceTimersByTimeAsync(200 + 400 + 800 + 1600);
    const result = await settled;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("Organization could not be created.");
    expect(calls).toHaveLength(PROVISION_MAX_ATTEMPTS);
    expect(deleted).toEqual(["org_1"]);
  });

  it("fails fast without retrying a permanent failure", async () => {
    const { deps, calls, deleted } = harness([() => errAsync("upstream_rejected")]);

    expect(await run(deps)).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(deleted).toEqual(["org_1"]);
  });

  it("fails org creation when the plugin has no credentials", async () => {
    const { deps, calls, deleted } = harness([() => errAsync("not_configured")]);

    expect(await run(deps)).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(deleted).toEqual(["org_1"]);
  });

  it("keeps the org without a customer when the not-configured policy is skip", async () => {
    const { deps, deleted } = harness([() => errAsync("not_configured")]);

    expect(await run({ ...deps, notConfiguredPolicy: "skip" })).toBe("ok");
    expect(deleted).toHaveLength(0);
  });

  it("ends at the deadline even when a provisioning call never settles", async () => {
    const { deps, calls, deleted } = harness([never]);

    const settled = run({ ...deps, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(deleted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(await settled).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(deleted).toEqual(["org_1"]);
  });

  it("skips a backoff that would run past the deadline", async () => {
    const { deps, calls, deleted } = harness([() => errAsync("upstream_unavailable")]);

    const settled = run({ ...deps, deadlineMs: 300 });
    await vi.advanceTimersByTimeAsync(200);

    expect(await settled).toBeInstanceOf(Error);
    expect(calls).toHaveLength(2);
    expect(deleted).toEqual(["org_1"]);
  });

  it("still fails creation when the rollback delete itself fails", async () => {
    const { deps } = harness([() => errAsync("upstream_rejected")]);

    const result = await run({
      ...deps,
      deleteOrganization: async () => {
        throw new Error("db down");
      },
    });

    expect((result as Error).message).toBe("Organization could not be created.");
  });
});

describe("abortableSleep", () => {
  it("resolves as soon as the signal aborts, mid-sleep", async () => {
    const controller = new AbortController();
    let resolved = false;
    void abortableSleep(10_000, controller.signal).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(resolved).toBe(true);
  });

  it("resolves after the timeout when the signal never aborts", async () => {
    const controller = new AbortController();
    let resolved = false;
    void abortableSleep(500, controller.signal).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(resolved).toBe(true);
  });
});
