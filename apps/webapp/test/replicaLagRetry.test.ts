import { describe, expect, it, vi } from "vitest";
import { findWithReplicaRetry } from "~/services/replicaLagRetry.server";

const base = { hasDedicatedReplica: true, retryDelayMs: { min: 0, max: 0 } };

describe("findWithReplicaRetry", () => {
  it("returns the first replica hit without retrying or touching the primary", async () => {
    const replicaFind = vi.fn().mockResolvedValue({ id: "env_1" });
    const primaryFind = vi.fn();
    const onOutcome = vi.fn();

    const result = await findWithReplicaRetry({ ...base, replicaFind, primaryFind, onOutcome });

    expect(result).toEqual({ id: "env_1" });
    expect(replicaFind).toHaveBeenCalledTimes(1);
    expect(primaryFind).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("recovers via a replica retry when the row appears on the second read", async () => {
    const replicaFind = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "env_1" });
    const primaryFind = vi.fn();
    const onOutcome = vi.fn();

    const result = await findWithReplicaRetry({ ...base, replicaFind, primaryFind, onOutcome });

    expect(result).toEqual({ id: "env_1" });
    expect(replicaFind).toHaveBeenCalledTimes(2);
    expect(primaryFind).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith("replica_retry");
  });

  it("falls back to the primary when the replica misses twice", async () => {
    const replicaFind = vi.fn().mockResolvedValue(null);
    const primaryFind = vi.fn().mockResolvedValue({ id: "env_1" });
    const onOutcome = vi.fn();

    const result = await findWithReplicaRetry({ ...base, replicaFind, primaryFind, onOutcome });

    expect(result).toEqual({ id: "env_1" });
    expect(replicaFind).toHaveBeenCalledTimes(2);
    expect(primaryFind).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith("primary");
  });

  it("reports a genuine miss and returns null", async () => {
    const replicaFind = vi.fn().mockResolvedValue(null);
    const primaryFind = vi.fn().mockResolvedValue(null);
    const onOutcome = vi.fn();

    const result = await findWithReplicaRetry({ ...base, replicaFind, primaryFind, onOutcome });

    expect(result).toBeNull();
    expect(onOutcome).toHaveBeenCalledWith("not_found");
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it("does a single lookup when there is no dedicated replica", async () => {
    const replicaFind = vi.fn().mockResolvedValue(null);
    const primaryFind = vi.fn();
    const onOutcome = vi.fn();

    const result = await findWithReplicaRetry({
      ...base,
      hasDedicatedReplica: false,
      replicaFind,
      primaryFind,
      onOutcome,
    });

    expect(result).toBeNull();
    expect(replicaFind).toHaveBeenCalledTimes(1);
    expect(primaryFind).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith("not_found");
  });

  it("does not fail the lookup when the outcome callback throws", async () => {
    const replicaFind = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "env_1" });
    const primaryFind = vi.fn();
    const onOutcome = vi.fn(() => {
      throw new Error("meter unavailable");
    });

    const result = await findWithReplicaRetry({ ...base, replicaFind, primaryFind, onOutcome });

    expect(result).toEqual({ id: "env_1" });
  });
});
