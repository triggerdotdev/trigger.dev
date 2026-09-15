import { describe, expect, it, vi } from "vitest";
import { publishClaim } from "~/v3/mollifier/idempotencyClaim.server";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";

// publishClaim compare-and-sets on the caller's token; a `false` result means a stale claimant already
// moved in (the winner's claim expired mid-pipeline), so the publish no-op'd. The caller must be able to
// SEE that rather than silently assuming its run is canonical.
function fakeBuffer(publishResult: boolean): MollifierBuffer {
  return { publishClaim: vi.fn(async () => publishResult) } as unknown as MollifierBuffer;
}

const base = {
  envId: "env_1",
  taskIdentifier: "task",
  idempotencyKey: "k",
  token: "tok",
  runId: "run_1",
  ttlSeconds: 30,
};

describe("publishClaim result", () => {
  it("returns false when the buffer compare-and-set no-ops (a stale claimant already moved in)", async () => {
    expect(await publishClaim({ ...base, buffer: fakeBuffer(false) })).toBe(false);
  });

  it("returns true when the publish sets the winner", async () => {
    expect(await publishClaim({ ...base, buffer: fakeBuffer(true) })).toBe(true);
  });

  it("returns true when the mollifier buffer is unavailable (nothing to converge)", async () => {
    expect(await publishClaim({ ...base, buffer: null })).toBe(true);
  });
});
